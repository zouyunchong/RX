# 瑞幸下单 H5

这是一个基于 `my-coffee` token 的 H5 页面，用来做：

- 附近门店查询
- 商品搜索
- 一句话智能下单
- 以往订单查看与状态查询

## 运行

```bash
npm start
```

默认地址：

```bash
http://localhost:4173
```

## 阿里云部署

目标访问地址：

```bash
http://masion.xyz/ai/rx
```

- 本项目 SOP：[deploy/SOP.md](deploy/SOP.md)
- 通用阿里云部署指引：[deploy/阿里云部署指引.md](deploy/阿里云部署指引.md)

快速部署：

```bash
export SSHPASS='服务器密码'   # 使用 SSH 密钥时可省略
bash deploy/deploy.sh
```

## 订单说明

这个版本能做到的是：

- 调用瑞幸 MCP 创建订单
- 在页面展示订单号和订单状态查询入口

页面已移除付款码和自动付款相关入口。

## Token 读取顺序

服务端会按这个顺序找 token：

1. 环境变量 `LUCKIN_MCP_TOKEN`
2. 本地文件 `~/.my-coffee/LUCKIN_MCP_TOKEN`

## 本地数据

订单记录保存在服务器：

`/opt/luckin-scheduler-h5/data/orders.json`
# RX
