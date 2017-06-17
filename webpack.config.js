const webpack = require('webpack');

const { entryPoint, setOutput } = require('@webpack-blocks/webpack2');
const path = require('path');

const appPath = (...names) => path.join(process.cwd(), ...names);

//This will be merged with the config from the flavor
module.exports = {
    entry: {
        main: [
            appPath('src', 'index.ts'),
            appPath('src', 'css', 'styles.scss')
        ]
    },
    output: {
        //filename: 'bundle.[hash].js',
        filename: 'index.js',
        path: appPath('build')
    },
    plugins: [
        new webpack.DefinePlugin({'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production')})
    ],
    target: 'electron-main'
};
