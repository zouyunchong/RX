# 瑞幸定时下单 H5 · 部署 SOP

> 适用项目：`luckin-scheduler-h5`  
> 目标访问地址：**https://masion.xyz/ai/rx/**（HTTP 自动跳转 HTTPS）  
> HTTPS 配置脚本：`deploy/setup-https.sh`  
> 最后更新：2026-06-12

---

## 1. 架构概览

```
用户浏览器
    │
    ▼
masion.xyz:443  (Nginx + Let's Encrypt)
    │
    ├── /              → 现有 AI 专卖静态站 (/var/www/ai-chat)
    │
    └── /ai/rx/        → 反向代理 → 127.0.0.1:4173 (Node.js)
                              │
                              ├── public/   前端静态文件
                              ├── data/     订单记录 orders.json
                              └── 瑞幸 MCP API (LUCKIN_MCP_TOKEN)
```

| 组件 | 路径 / 端口 |
|------|-------------|
| 项目代码（服务器） | `/opt/luckin-scheduler-h5` |
| Node 服务 | `luckin-scheduler`，监听 `127.0.0.1:4173` |
| 环境变量 | `/opt/luckin-scheduler-h5/.env` |
| Nginx 片段 | `/etc/nginx/snippets/luckin-rx.conf` |
| Nginx 主配置 | `/etc/nginx/conf.d/masion.conf` |
| SSL 证书 | `/etc/letsencrypt/live/masion.xyz/`（至 2026-09-10） |
| ECS 公网 IP | `47.112.168.59` |
| 域名 | `masion.xyz` → A 记录指向上述 IP |

---

## 2. 部署前检查清单

### 本地环境

- [ ] 项目目录：`Ai资讯/`
- [ ] 瑞幸 MCP Token 已配置（二选一）：
  - `~/.my-coffee/LUCKIN_MCP_TOKEN`
  - 或环境变量 `LUCKIN_MCP_TOKEN`
- [ ] 可 SSH 登录服务器（密钥或密码）
- [ ] 若用密码登录，本机已安装 `sshpass`：
  ```bash
  brew install hudochenkov/sshpass/sshpass
  ```

### 服务器环境

- [ ] 阿里云安全组已放行 **80** 端口
- [ ] 域名 `masion.xyz` DNS 已解析到 `47.112.168.59`
- [ ] Nginx 已安装并运行（同机已有 AI 专卖站点）
- [ ] Node.js 18+（首次部署脚本会自动安装 Node 20）

### 前端路径约定

本项目挂载在 **子路径** `/ai/rx/`，前端 API 使用相对路径（如 `api/health`），**不要**改成 `/api/...` 绝对路径，否则子路径下会 404。

---

## 3. 日常部署（推荐，约 30 秒）

> 代码有更新时使用，会覆盖服务器代码并重启服务。

### 3.1 使用 SSH 密钥（推荐）

```bash
cd /Users/goc/Documents/Ai资讯
bash deploy/deploy.sh
```

### 3.2 使用密码登录

```bash
cd /Users/goc/Documents/Ai资讯
export SSHPASS='你的服务器密码'
bash deploy/deploy.sh
```

### 3.3 自定义参数（可选）

```bash
SERVER_USER=root \
SERVER_HOST=47.112.168.59 \
SSH_PORT=22 \
REMOTE_DIR=/opt/luckin-scheduler-h5 \
LUCKIN_MCP_TOKEN=xxx \
bash deploy/deploy.sh
```

### 3.4 脚本自动完成的步骤

1. 测试 SSH 连接
2. `rsync` 同步代码到 `/opt/luckin-scheduler-h5`（排除 `.git`、`node_modules`）
3. 远程：安装 Node（若缺失）、写 `.env`、注册并重启 `luckin-scheduler` systemd 服务
4. 远程：更新 Nginx 片段并 reload
5. 公网健康检查 `http://masion.xyz/ai/rx/api/health`

---

## 4. 首次部署说明

首次与日常部署使用**同一脚本** `deploy/deploy.sh`，额外会：

- 在服务器安装 Node.js 20（Alibaba Cloud Linux / CentOS 用 dnf）
- 创建 `/opt/luckin-scheduler-h5` 目录
- 注册 systemd 服务 `luckin-scheduler` 并设置开机自启
- 将 `deploy/nginx-location-rx.conf` 安装到 `/etc/nginx/snippets/luckin-rx.conf`
- 自动在现有 Nginx 站点配置中注入：
  ```nginx
  include /etc/nginx/snippets/luckin-rx.conf;
  ```

> **注意**：`/ai/rx/` 是**追加**到现有 `masion.xyz` 站点，不会覆盖 AI 专卖首页。

---

## 5. 部署后验证

### 5.1 快速验收（本地执行）

```bash
# 页面应返回「瑞幸定时下单」
curl -s http://masion.xyz/ai/rx/ | grep -o '瑞幸定时下单'

# API 健康检查，期望 tokenReady: true
curl -s http://masion.xyz/ai/rx/api/health

# 确认原站点未受影响
curl -sI http://masion.xyz/ | head -3
```

### 5.2 浏览器验收

1. 打开 http://masion.xyz/ai/rx/
2. 页面顶部显示「瑞幸定时下单」
3. 健康状态徽章显示 MCP 已就绪（非「检查 MCP 中…」报错）
4. 输入「工作日9点 TCL国际E城 冰美式」测试智能创建

### 5.3 服务器端验收

```bash
ssh root@47.112.168.59

systemctl status luckin-scheduler    # active (running)
curl -s http://127.0.0.1:4173/api/health
nginx -t
```

---

## 6. 常用运维命令

### 服务管理

```bash
# 查看状态
systemctl status luckin-scheduler

# 重启
systemctl restart luckin-scheduler

# 查看日志
journalctl -u luckin-scheduler -f --no-pager
```

### 更新 Token

```bash
# 方式 A：重新部署（会从本机 ~/.my-coffee/LUCKIN_MCP_TOKEN 同步）
export SSHPASS='密码' && bash deploy/deploy.sh

# 方式 B：服务器上直接改
ssh root@47.112.168.59
echo 'LUCKIN_MCP_TOKEN=新token' > /opt/luckin-scheduler-h5/.env
chmod 600 /opt/luckin-scheduler-h5/.env
systemctl restart luckin-scheduler
```

### Nginx

```bash
nginx -t && systemctl reload nginx
cat /etc/nginx/snippets/luckin-rx.conf
grep luckin-rx /etc/nginx/conf.d/ai-chat.conf
```

### 查看定时任务数据

```bash
cat /opt/luckin-scheduler-h5/data/tasks.json
```

---

## 7. 故障排查

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| `/ai/rx/` 显示 AI 专卖首页 | Nginx 未注入 `/ai/rx/` 代理 | 检查 `grep luckin-rx /etc/nginx/conf.d/*.conf`，重新跑 `deploy.sh` |
| 页面 502 / 504 | Node 服务未启动 | `systemctl status luckin-scheduler`，看 `journalctl -u luckin-scheduler` |
| API 返回 token 未配置 | `.env` 缺失或 Token 过期 | 更新 `/opt/luckin-scheduler-h5/.env` 并重启服务 |
| SSH Permission denied | 密钥未授权或密码错误 | 阿里云控制台重置密码 / 绑定密钥；本机用 `export SSHPASS=...` |
| 本地 Node 正常、公网不通 | 安全组 / DNS | 确认 80 端口放行、`masion.xyz` 解析到 `47.112.168.59` |
| 定位 / 语音不可用 | HTTP 非 HTTPS 限制 | 已知限制；门店关键词搜索不受影响 |

---

## 8. 回滚

### 仅回滚代码（保留 Nginx 配置）

```bash
# 从 git 检出旧版本后重新部署
git checkout <旧commit>
export SSHPASS='密码' && bash deploy/deploy.sh
```

### 临时下线 `/ai/rx/`（不影响主站）

```bash
ssh root@47.112.168.59
systemctl stop luckin-scheduler
# 可选：注释 ai-chat.conf 中的 include luckin-rx.conf 行
nginx -t && systemctl reload nginx
```

---

## 9. 安全建议

1. **优先改用 SSH 密钥**，减少密码登录：
   ```bash
   ssh-copy-id root@47.112.168.59
   ```
2. 服务器 `.env` 权限应为 `600`，不要提交到 git
3. 部署完成后可在阿里云修改 root 密码
4. 不要在聊天记录 / 文档中明文保存服务器密码

---

## 10. 相关文件索引

| 文件 | 用途 |
|------|------|
| `deploy/deploy.sh` | 一键部署脚本（主入口） |
| `deploy/SOP.md` | 本文档 |
| `deploy/luckin-scheduler.service` | systemd 服务单元 |
| `deploy/nginx-location-rx.conf` | Nginx `/ai/rx/` 反向代理片段 |
| `deploy/nginx-masion-rx.conf` | 独立 server 块示例（仅无现有站点时用） |
| `server.mjs` | Node 后端 + 定时调度 |
| `public/` | 前端静态资源 |

---

## 11. 一键备忘

```bash
# 本地开发
npm start
# → http://localhost:4173

# 生产部署
cd /Users/goc/Documents/Ai资讯
export SSHPASS='服务器密码'   # 若用密钥可省略
bash deploy/deploy.sh

# 验收
curl -s http://masion.xyz/ai/rx/api/health
# 期望：{"ok":true,"tokenReady":true}
```
