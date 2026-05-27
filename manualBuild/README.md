# 手动打包界面

## 直接运行

双击项目根目录下的 `start-manual-build.bat`，或执行：

```bat
npm run manual-build
```

启动后打开 `http://127.0.0.1:3921`。这个开发启动脚本会读取你本机的正式 `autoBuild/cfg.yaml`，和 exe 默认端口 `3918` 分开，不会互相占用。

界面可以选择项目和日期，也可以修改发件人、Git 和项目配置。保存配置会写回当前正在使用的 `cfg.yaml`。

## 生成 exe

执行项目根目录下的 `make-manual-build-exe.bat`，或执行：

```bat
npm run build:manual-exe
```

生成后文件在 `dist/zbcx-web-pack.exe`。脚本会生成一个空的 `dist/autoBuild/cfg.yaml`，不会复制本机真实配置。首次给别人使用时，让对方打开界面填写配置并保存。

需要一起交付整个 `dist` 目录：

```text
dist/
  zbcx-web-pack.exe
  autoBuild/
    cfg.yaml
    build-history.json
  manualBuild/
    public/
```

如果 `npx` 下载失败，先检查 npm registry/proxy 配置。`make-manual-build-exe.bat` 会临时清空常见代理环境变量，不会修改系统配置。
