# DualSense Web Kernel Haptics Implementation Plan

## 背景

目标是在 PeaSyo4Desk 的 Web 手柄内核中实现 DualSense / DualSense Edge 的真实触觉反馈。Native 手柄内核暂不处理。

已有的 PeaSyo haptic 实现不作为兼容约束，可以直接按 `dualsense-tester` 的验证逻辑重做。参考实现路径：

- `/Users/lijiahao/Desktop/lijiahao/open-source/OpenPs/dualsense-tester/src/components/common/MediaFilePlayer.vue`
- `/Users/lijiahao/Desktop/lijiahao/open-source/OpenPs/dualsense-tester/src/composables/useDualSensePlayer.ts`
- `/Users/lijiahao/Desktop/lijiahao/open-source/OpenPs/dualsense-tester/src/composables/useBtAudioPlayer.ts`
- `/Users/lijiahao/Desktop/lijiahao/open-source/OpenPs/dualsense-tester/src/utils/dualsense/btAudioStream.ts`

## dualsense-tester 的关键结论

`MediaFilePlayer.vue` 本身只是 UI 入口，真正的触觉实现分 USB 和 Bluetooth 两条路径：

1. USB DualSense
   - 不通过 HID haptic report 播放触觉。
   - 把 DualSense 当作一个多声道音频输出设备。
   - 用 `AudioContext.setSinkId()` 选中 DualSense audio output。
   - 设置 `destination.channelCount = 4`、`channelInterpretation = "discrete"`。
   - 声音输出到 ch0/ch1。
   - 触觉输出到 ch2/ch3，对应左右触觉马达。

2. Bluetooth DualSense
   - 不走系统音频输出。
   - 使用 HID `sendReport(0x36, payload)`。
   - `0x36` 报告同时包含：
     - 控制子包 `0x90`
     - Opus 音频子包 `0x91`
     - 64 字节触觉 PCM 子包 `0x92`
   - 音频子包需要 200 字节 Opus frame。只需要触觉时，也要填一帧 silent Opus。
   - 触觉子包是 64 字节 signed int8 stereo PCM，布局为 `[L0, R0, L1, R1, ...]`。
   - 每包约 10.667ms，调度时用音频时钟或等价单调时钟控制节奏。
   - 报告末尾需要按 `[0xA2, reportId] + payloadWithoutCrc` 计算 CRC32。

## PeaSyo 当前可复用的数据入口

主进程已经能从 `peasyo-lib` 收到 `onHapticsFrame(frame)`，并广播给 renderer：

- native binary：`WS_BINARY_HAPTIC`
- websocket/text fallback：`session_event: haptic_audio`

该数据应作为唯一触觉输入源。不要从游戏音频重新提取触觉。

预期输入格式：

- `format: "s16le"`
- `channels: 2`
- stereo interleaved PCM
- 每帧包含一段触觉 PCM

后续实现应保留这个数据流，但替换 renderer Web 内核下的播放后端。

## 目标架构

新增一个独立的 Web DualSense haptics 层，例如：

- `renderer/lib/dualsenseHaptics/`
- `renderer/lib/dualsenseHaptics/index.ts`
- `renderer/lib/dualsenseHaptics/usbAudioSink.ts`
- `renderer/lib/dualsenseHaptics/bluetoothReport36Sink.ts`
- `renderer/lib/dualsenseHaptics/report36.ts`
- `renderer/lib/dualsenseHaptics/pcm.ts`

对外暴露统一接口：

```ts
type DualSenseHapticSink = {
  supports(device): boolean;
  start(): Promise<boolean>;
  pushPcmS16Le(frame: Uint8Array, options: { gain: number; seq?: number }): boolean;
  stop(): void;
  dispose(): void;
};
```

renderer 页面只依赖统一入口：

```ts
triggerDualSenseWebHapticsFromPeasyo(event, {
  enabled: settings.haptic === true,
  gain: settings.haptic_feedback_intensity,
});
```

## 设备选择和连接类型

继续使用现有 WebHID 授权和 DualSense 设备管理逻辑，但连接类型判断要服务于新后端：

- USB：走 `UsbDualSenseAudioHapticSink`
- Bluetooth：走 `BluetoothDualSenseReport36HapticSink`
- Unknown：不播放真实触觉，降级到普通 rumble fallback

连接类型可以继续基于 HID collection input report bits 判断：

- USB input report bits 约 `504`
- Bluetooth input report bits 约 `616`

## USB 实现方案

### 核心思路

对齐 `dualsense-tester/src/composables/useDualSensePlayer.ts`：

- 通过 `navigator.mediaDevices.enumerateDevices()` 找到 DualSense audio output。
- 优先匹配 label：
  - `dualsense`
  - `wireless controller`
- 用 `AudioContext.setSinkId(deviceId)` 切到 DualSense 输出。
- 配置 4 声道输出：
  - ch0/ch1 保持静音或不用
  - ch2/ch3 写入左右触觉 PCM

### PeaSyo 的实时流处理

PeaSyo 收到的是实时 PCM frame，不是一个完整文件，所以不适合用 `AudioBufferSourceNode` 一次性播放。建议实现 AudioWorklet ring buffer：

1. renderer 收到 `WS_BINARY_HAPTIC` 或 `haptic_audio`。
2. 解析 `s16le stereo`。
3. 转成 float stereo，应用 gain。
4. 从 haptic PCM 采样率重采样到当前 `AudioContext.sampleRate`。
5. 写入 AudioWorklet 的 ring buffer。
6. AudioWorklet 持续输出 4 声道：
   - output[0] = 0
   - output[1] = 0
   - output[2] = left haptic
   - output[3] = right haptic

为了低延迟：

- ring buffer 目标播放余量控制在 20-40ms。
- 积压超过 60ms 时丢弃旧 frame，保留最新触觉。
- 输入短缺时输出 0，避免马达残留震动。
- 停止串流时立即 flush 并输出短静音。

### USB 需要的用户授权

浏览器只有拿到音频设备 label 后才能可靠自动选 DualSense。

策略：

1. 如果支持 `navigator.mediaDevices.selectAudioOutput()`，在用户点击连接/开始串流时请求选择输出设备。
2. 如果不支持，调用一次 `getUserMedia({ audio: true })` 解锁 device label，然后 `enumerateDevices()`。
3. 自动匹配 DualSense audio output。
4. 未找到时提示用户手动选择系统输出为 DualSense，或降级到 rumble。

## Bluetooth 实现方案

### 核心思路

对齐 `dualsense-tester/src/composables/useBtAudioPlayer.ts` 和 `btAudioStream.ts`：

- 每 10.667ms 发送一包 `0x36` report。
- report 内必须同时包含 silent Opus 音频子包和 haptic PCM 子包。
- 不需要播放真实声音时，音频子包使用 silent Opus。
- 触觉子包填 64 字节 signed int8 stereo PCM。

### 报告格式

实现 `buildReport36()`，按 tester 的 `buildReportSix()` 对齐：

- payload 长度：397 字节，不含 report id。
- `payload[0] = ((seq & 0x0f) << 4)`
- control 子包：
  - `payload[1] = 0x90`
  - `payload[2] = 0x3f`
  - speaker/headphone 音量和 audioControl 字段按 tester 填。
- audio 子包：
  - `payload[66] = 0x91`
  - `payload[67] = 0x07`
  - `payload[68] = 0xfe`
  - `payload[74] = frameCounter`
  - `payload[75] = 0x93` speaker route，默认即可
  - `payload[76] = 0xc8`
  - `payload[77..276] = silentOpusFrame`
- haptic 子包：
  - `payload[277] = 0x92`
  - `payload[278] = 0x40`
  - `payload[279..342] = hapticFrame64`
- 末 4 字节写 CRC32：
  - prefix `[0xa2, 0x36]`

发送：

```ts
hidDevice.sendReport(0x36, payload)
```

### silent Opus

有两种实现选项：

1. 优先：移植 tester 的 `encodeSilentOpusFrame()`，使用 `AudioEncoder` 生成 silent Opus。
2. 保底：内置一帧经过验证的 silent Opus 200 字节常量。

建议两者都做：

- 支持 `AudioEncoder` 时运行时生成。
- 不支持时使用常量。

### haptic PCM 转换

输入是 `s16le stereo`，蓝牙 report 需要 `int8 stereo`：

1. 读取 `int16 little-endian`。
2. 按 gain 缩放。
3. soft limiter，避免削波：
   - 可沿用 PeaSyo 现有 `tanh` 逻辑，或简化为 clamp。
4. 量化为 signed int8 byte：
   - `[-128, 127] -> [0x80..0xff, 0x00..0x7f]`
5. 每包 64 字节。
6. 输入不足 64 字节时补 0。
7. 输入超过 64 字节时切成多个 haptic frame。

### 蓝牙调度

不要收到一帧就立即无限制发送。实现一个 queue + clock scheduler：

- tick 间隔：约 10.667ms。
- 每 tick 最多发送 1-2 包。
- backlog 超过 40ms 时丢旧包，保留最新包。
- 页面后台或事件循环卡顿导致积压时，直接跳到最新位置。
- `sendSeq = (sendSeq + 1) & 0x0f`
- `frameCounter = (frameCounter + 1) & 0xff`

建议使用 `setTimeout` + `performance.now()`，不要依赖 `requestAnimationFrame`，因为串流时窗口可能全屏、后台、或者渲染线程繁忙。

## 与现有 rumble fallback 的关系

主进程现在会对同一 haptic frame 同时发：

1. 原始 haptic PCM
2. 从 peak 派生出来的 rumble fallback

新实现保留这个策略，但 renderer 逻辑调整为：

- Web 内核 + DualSense 真触觉成功入队：记录 `hapticFrameSeq`，忽略同 seq 的 rumble fallback。
- Web 内核 + DualSense 真触觉不可用：执行普通 Gamepad rumble fallback。
- Native 内核：保持现有 native rumble 路径，不受影响。

## 设置项

当前 `renderer/common/settings.ts` 中 `haptic` 设置项被注释，默认值在 `userContext.defaults.ts` 为 `false`。要让功能可用，需要恢复设置项。

建议：

- `haptic`: 是否启用 DualSense 触觉反馈。
- `haptic_feedback_intensity`: 触觉强度，使用 0.5 / 1.0 / 1.5 三档；Web USB 输出链路额外应用 2.5x 整体增益，用于补偿桌面端 AudioContext 到 DualSense USB audio sink 的体感偏弱。
- 仅当 `gamepad_kernel === "web"` 时说明此功能生效。
- 如果用户开启 `haptic`，但没有 DualSense 或授权失败，自动降级 rumble，并在 verbose log 中记录原因。

默认值建议保持 `false`，避免首次启用时突然请求 WebHID / audio output 权限。

## 页面集成点

需要同时覆盖两条串流页面：

- `renderer/pages/[locale]/stream.tsx`
- `renderer/pages/[locale]/webStream.tsx`

需要替换或重写：

- `triggerGamepadHapticsFromPeasyo(...)`
- `canUseDualSenseGamepadHaptics(...)`
- `handleHapticFrameBytes(...)`
- `session_event: haptic_audio` 分支
- rumble fallback suppression 逻辑

建议把重复逻辑抽到共享 helper，避免 `stream.tsx` 和 `webStream.tsx` 再各维护一份。

## 清理旧实现

可以废弃或重写当前 `renderer/lib/dualsenseHid.ts` 中与 haptic 相关的旧逻辑：

- `DUALSENSE_HAPTIC_REPORT_ID = 0x32`
- `DUALSENSE_HAPTIC_REPORT_ID_MAX = 0x39`
- `sendHapticPrimePacket`
- `sendHapticReport`
- `pendingHapticSamples`
- `hapticPrimed`
- `hapticStreaming`

保留 WebHID 设备发现、输入解析、触摸板、扳机、LED、普通 rumble 等能力。也可以把 haptic 相关代码迁移到新的 sink 模块里，避免 `dualsenseHid.ts` 继续膨胀。

## 实施步骤

1. 新增 `dualsenseHaptics` 模块
   - 连接类型识别
   - PCM 工具
   - CRC32
   - Bluetooth `0x36` report builder
   - USB AudioWorklet sink

2. 实现 Bluetooth 触觉
   - silent Opus 准备
   - s16le -> int8 stereo 64-byte frame
   - 10.667ms scheduler
   - `sendReport(0x36, payload)`

3. 实现 USB 触觉
   - DualSense audio output 发现和授权
   - `AudioContext.setSinkId`
   - 4 声道 destination
   - AudioWorklet ring buffer
   - ch2/ch3 输出触觉

4. 接入 renderer 串流页面
   - binary haptic path
   - text fallback haptic path
   - rumble fallback suppression
   - stream stop cleanup

5. 恢复设置项
   - 打开 `haptic` radio 配置
   - 文案说明 Web 内核 + DualSense 才生效

6. 移除或隔离旧 haptic report 实现
   - 避免同时走两套 haptic 输出
   - 保留普通 rumble / trigger / led

## 验收标准

1. USB DualSense
   - Web 内核下开启 haptic 后，Remote Play 触觉事件能从手柄触觉马达输出。
   - 同一事件不再同时触发普通 rumble fallback。
   - 关闭 haptic 后恢复普通 rumble fallback。
   - 停止串流后触觉立即停止，无残留震动。

2. Bluetooth DualSense
   - 能持续发送 `0x36` report。
   - 触觉低延迟、无明显拖尾。
   - 切后台 / 窗口卡顿后不会积压一串过期触觉。
   - 停止串流后发送静音触觉或清空 queue，手柄停止震动。

3. 非 DualSense / 未授权 / 不支持环境
   - 不报错。
   - 自动降级普通 Gamepad rumble。
   - Native 手柄内核行为不变。

4. 平台覆盖
   - macOS / Windows / Linux Electron WebHID 可用性分别验证。
   - `stream.tsx` 和 `webStream.tsx` 两个页面都验证。

## 风险点

1. USB audio output 设备选择依赖浏览器权限和 `setSinkId` 支持。
2. Bluetooth `0x36` report 需要准确 CRC 和 silent Opus，否则手柄可能忽略包。
3. `sendReport` 频率过高会造成 HID 队列压力，需要严格限速和丢弃过期包。
4. 触觉 PCM gain 过高会削波，过低会感觉不明显，需要保留强度档位并允许调参。
5. 需要确保 trigger/LED/rumble 普通 output report 不覆盖蓝牙 `0x36` audio/haptic stream 状态。

## 推荐优先级

第一阶段先做 Bluetooth `0x36`，因为它完全在 WebHID 内闭环，和 tester 逻辑最一致，验证路径清晰。

第二阶段做 USB AudioWorklet 4 声道输出，因为它涉及 audio output 权限、`setSinkId`、设备选择和实时重采样，平台差异更大。

第三阶段做 UI/设置完善和旧 haptic 代码清理。
