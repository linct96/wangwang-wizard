# Wangwang Wizard 部署 Wangwang 执行方案

## 目标

将向导从“创建 Cloudflare 资源”扩展为“部署 Wangwang 可用实例”。第一版只支持 Cloudflare Workers，使用 Wangwang 的版本化预构建部署包，不在浏览器中编译本地源码。

## 范围

第一版包含：

- 创建或复用 D1、KV、Queue
- 下载并校验 Wangwang 版本化部署包
- 执行 D1 migration
- 上传 Worker 与静态资源
- 配置 D1、KV、Queue bindings
- 写入环境变量与 `SUBSCRIPTION_TOKEN_SECRET`
- 使用 `workers.dev` 地址完成健康检查
- 流式显示部署阶段、错误和最终地址

第一版暂不包含：Pages、自定义域名自动绑定、Cloudflare Access 自动创建、多实例管理和本地源码上传。

## 部署包

Wangwang 通过 GitHub Release 发布以下文件：

```text
wangwang-deploy-vX.Y.Z.tar.gz
wangwang-deploy-vX.Y.Z.tar.gz.sha256
```

解压后必须包含 `manifest.json`、`worker.js`、`assets/` 和 `migrations/`。manifest 描述版本、入口文件、资源目录、迁移目录、bindings、vars 和 secrets，向导在上传前校验其完整性与 SHA-256。

## 部署流程

```text
validate -> artifact -> d1 -> kv -> queue -> migration -> worker -> secret -> healthcheck -> complete
```

默认复用同名资源；勾选“强制重新创建资源”时删除同名 Worker、D1、KV、Queue 后重新创建，已有数据、队列消息、Secret 和 Worker 部署记录不可恢复。migration 记录已执行项并保持幂等；失败时不自动删除资源，允许用户安全重试。未勾选强制重建时已有 Secret 默认保留，避免订阅链接意外失效。

## Token 安全

Token 只在当前请求期间使用，不写入 KV、D1、URL、日志或分析系统。日志必须脱敏。部署接口完成后立即释放 Token 引用。

## 验收标准

- D1、KV、Queue producer/consumer 均已配置
- migration 执行完成且可重复执行
- `/healthz` 返回 `200`
- `/admin` 可返回管理页面
- 未通过 Access 的管理 API 返回 `401`
- 有效订阅 URL 返回生成的 YAML

## 开发顺序

1. 准备 Wangwang 构建产物和 manifest。
2. 验证 Cloudflare Worker/Assets 上传 API。
3. 实现 Wizard `POST /api/deploy` 部署状态机。
4. 接入 migration、bindings、vars 和 secret。
5. 改造前端参数、流式日志和结果展示。
6. 使用专用 Cloudflare 账户完成真实部署、重复部署和失败重试测试。
