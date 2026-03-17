module.exports = {
    // // specify an alternate main src directory, defaults to 'main'
    // mainSrcDir: 'main',
    // // specify an alternate renderer src directory, defaults to 'renderer'
    // rendererSrcDir: 'renderer',
  
    // main process' webpack config
    webpack: (config, env) => {
        const optionalWsNativeDeps = {
            bufferutil: "commonjs bufferutil",
            "utf-8-validate": "commonjs utf-8-validate",
        }

        if (Array.isArray(config.externals)) {
            config.externals.push(optionalWsNativeDeps)
        } else if (config.externals) {
            config.externals = [config.externals, optionalWsNativeDeps]
        } else {
            config.externals = [optionalWsNativeDeps]
        }

        config.entry.background = './main/application.ts'
        config.entry.preload = './main/preload.ts'
        config.module.rules.push({
            test: /\.node$/,
            loader: "node-loader",
        })
        return config;
    },

    // webpack: (defaultConfig, env) => Object.assign(defaultConfig, {
    //     entry: {
    //       background: './main/application.ts',
    //     },
    //     module: {
    //         rules: [...(defaultConfig.module.rules ? defaultConfig.module.rules : []), {
    //             test: /\.node$/,
    //             loader: "node-loader",
    //         }]
    //     }
    //   }),
  };
