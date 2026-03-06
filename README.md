# 课堂签到 + 习惯盲盒（链接版）

这是一个极简签到网站（v3.0）：
- 老师输入名单，生成两个链接
- `学生签到链接` 发给同学
- `老师统计链接` 实时看签到情况
- 学生端规则：先签到，再抽盲盒
- 盲盒抽取次数不限，且全员可见实时抽取记录

## 一键部署到公网（Render）

### 1) 上传到 GitHub
把 `checkin-blindbox-share` 文件夹上传到一个新的 GitHub 仓库。

### 2) 在 Render 创建服务
1. 打开 [Render](https://render.com/) 并登录
2. 点击 `New +` -> `Blueprint`
3. 选择你刚才的 GitHub 仓库
4. Render 会自动识别 `render.yaml`，直接点创建
5. 等待部署完成，得到一个公网链接（形如 `https://xxx.onrender.com`）

### 3) 开始使用
1. 打开 `https://xxx.onrender.com`
2. 粘贴学生名单（每行一个）并创建
3. 复制“学生签到页”链接发给大家
4. 老师打开“统计页”链接看实时签到，必要时点“导出 CSV”备份

## 本地运行（可选）

```bash
cd checkin-blindbox-share
node server.js
```

浏览器打开 `http://localhost:3000`

## 注意
- Render 免费实例可能会休眠，第一次打开会慢几秒。
- 如果你想长期保留历史数据，建议每次课后在统计页导出 CSV。
- 当前数据默认保存在服务器本地 `data.json`，重新部署可能会清空历史。
