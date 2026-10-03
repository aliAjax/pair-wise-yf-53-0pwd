# pair-wise-yf-53 开源项目发布列车准备和门禁控制台

## 源提示词摘要
维护者创建跨仓库发布，关联版本、负责人、阻断问题和待合并依赖，安排冻结时间与分批顺序。发布前检查依赖、阻断、超时确认和顺序冲突，支持冻结、降级、回滚准备状态及可追溯审计。

## 技术栈
React Router 7 框架模式 + TypeScript + Mantine + Redux Toolkit + RTK Query + React Hook Form + Zod + Lingui + dnd-kit。

## 已实现闭环
- 跨仓库发布列车、依赖门禁和阻断问题三类业务对象。
- 门禁确认、阻断关闭、发布冻结、回滚和恢复准备状态。
- 仓库顺序拖拽、表单校验、远端健康查询与审计历史。
- localStorage 持久化。

## 门禁失效与冻结规则
- 门禁确认不是永久有效：仓库登记新版本后，其自身已确认的门禁立即失效；钉版依赖该仓库的下游门禁，当钉版与新版本不兼容时也立即失效，必须重新确认才能参与冻结（登记新版本按同一套判断）。
- 失效门禁在界面上明确标橙并展示原因，冻结控制区逐条列出仍不满足的条件。
- 拖动分批顺序时校验依赖方向：下游仓库不能排到上游前面，非法移动被拒绝、退回原顺序并写审计。
- 只有全部仓库门禁处于已确认状态、且没有未关闭的严重（critical）阻断项时才允许冻结；不满足时冻结按钮禁用，reducer 同样硬性拒绝。
- 所有状态（含失效原因、顺序、冻结状态）持久化到 localStorage，重开页面与关闭前一致。

## 规则验证
```bash
npx esbuild scripts/verify-logic.ts --bundle --platform=node --format=esm --outfile=/tmp/verify.mjs && node /tmp/verify.mjs
```

## 启动
```bash
npm install
npm run dev
```
开发端口：62018
