import { PS_GAMEPAD_SVG_ICONS } from "../../common/gamepadIcons";

type PsGamepadIconProps = {
  action: string;
  size?: number;
  className?: string;
};

const removeXmlHeaders = (svg: string) => {
  return svg
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .trim();
};

function PsGamepadIcon(props: PsGamepadIconProps) {
  const source = PS_GAMEPAD_SVG_ICONS[props.action];
  if (!source) {
    return null;
  }

  const normalized = removeXmlHeaders(source);
  const size = props.size ?? 28;

  return (
    <span
      className={`ps-gamepad-icon ${props.className || ""}`.trim()}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: normalized }}
    />
  );
}

export default PsGamepadIcon;
