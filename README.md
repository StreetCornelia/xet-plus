# 小鹅通课程页布局重构

一个用于小鹅通 PC 课程详情播放页的 Tampermonkey 用户脚本：把课程页重构为 16:9 播放器 + 完整选集面板，并记住播放参数。

## 功能

- **16:9 播放器**：限制最大宽度 1200px，隐藏标签区、右侧推荐和评论等干扰内容。
- **全屏三态**：复用站点原图标，普通 / 网页宽屏 / 原生全屏切换；双击视频进入网页全屏；隐藏左上角返回图标。
- **播放参数记忆**：记住音量、静音、倍速、播放形式（单集 / 循环 / 连续），刷新或切换课时后自动恢复。
  - 只在首次进入课时和视频切换时应用一次，不做定时轮询覆盖。
- **选集面板**：控制条「选集」按钮打开完整课程目录，支持章节分组、搜索、当前课高亮、自动定位、时长、已学完/进度和直播标记。
- 列表页（`camp_pro` 等）完全不加载脚本。

## 安装

### 从 GitHub 安装（推荐自行维护）

仓库需要是 **Public**，然后打开下面的 raw 链接安装：

```text
https://raw.githubusercontent.com/StreetCornelia/xet-plus/refs/heads/main/xet-course-layout.user.js
```

Tampermonkey 会自动识别用户脚本并进入安装页。

### 从 Greasyfork 安装

脚本页：<https://greasyfork.org/zh-CN/scripts/565101>

## 使用

1. 打开任意小鹅通 PC 课程播放页（`/p/t_pc/course_pc_detail/video/...`）。
2. 播放器控制条会出现「选集」按钮，点击打开课程目录。
3. 点击视频课时会跳到对应课时；直播回放使用接口返回的链接在新标签打开。
4. 音量、倍速、播放形式会自动保存在浏览器本地，下次进入该课程或切换课时后恢复。

## 工作原理

### 布局

脚本在 `document-start` 注入样式，只给播放页的 `body` 加 `xet-rebuild` 类；所有样式都限定在这个类下，列表页不匹配、不注入。

### 播放参数

- 保存键：`localStorage["xet-playback-prefs-v1"]`
- 内容：`{ volume, muted, rate, playmode }`
- 恢复时机：`loadedmetadata` / `loadstart` / `emptied`、视频 `src` 变化、课程标题变化、history pushState/replaceState、浏览器标题变化。
- 每个触发只应用一次，并在约 1.4 秒后做一次校正；没有 `setInterval`。

### 选集目录

目录来自站点自己的接口（同源 POST，携带站点登录 Cookie）：

```text
POST /xe.course.business_go.avoidlogin.e_course.resource_catalog_list.get/1.0.0
Content-Type: application/json
app_id: <站点子域名>

{ "bizData": { "app_id": "...", "course_id": "...", "page": 1, "page_size": 1000 } }
```

- 顶层返回章节列表；对 `section_num > 0` 的章节，用 `p_id: chapter_id` 再请求一次子列表。
- 当前课程示例：35 个顶层章节 / 31 个有内容章节 / 256 个小节。
- 缓存：`sessionStorage["xet-catalog-v2:<course_id>"]`，10 分钟；失败不缓存。
- 页面空闲约 2.5 秒后预取，打开面板时直接渲染。

## 权限与隐私

- 不向任何第三方上传数据。
- 目录请求只发往当前小鹅通站点的同源接口，使用浏览器里已有的登录 Cookie。
- 只读写本站 `localStorage` / `sessionStorage` 中的播放偏好与目录缓存。
- 脚本本身不包含 token、密钥或账号信息。

## 兼容性与限制

- 匹配 `https://*.pc.xiaoe-tech.com/p/t_pc/course_pc_detail/video/*`，适用于所有小鹅通 PC 租户。
- 子域名 `*` 只覆盖小鹅通平台，不会匹配其他网站；Greasy Fork 仍可能提示通配符，这是建议而不是拒绝。只想覆盖自己租户时，可以改成具体子域名。
- 视频课时跳转使用整页加载；直播回放使用接口的 `jump_url` 在新标签打开。
- 非视频、非直播资源如果接口没有返回 `jump_url`，会显示但不可跳转。
- 课程目录接口需要登录态；未登录或接口变更时面板会显示加载失败和重试按钮。

## Greasy Fork 源代码同步

Greasy Fork 的「源代码同步」从 GitHub 仓库读取 `.user.js` 文件，填 raw 链接即可。

### 1. raw 链接

```text
https://raw.githubusercontent.com/StreetCornelia/xet-plus/refs/heads/main/xet-course-layout.user.js
```

- 仓库必须是 **Public**；私有仓库 Greasy Fork 拉不到。
- 链接必须直接指向 `.user.js` 文件，不是仓库首页，也不是 GitHub 文件预览页。

### 2. 在 Greasy Fork 管理页填写

打开脚本的「管理 → 源代码同步」：

- 安装链接：上面的 raw 链接
- 同步方式：验证阶段先选「手动」；确认稳定后再改「自动」
- 点「更新设置并立即同步」

### 3. Webhook（可选）

Greasy Fork 在设置源代码同步后会给出 Webhook 地址。到 GitHub 仓库的 **Settings → Webhooks → Add webhook**：

- Payload URL：Greasy Fork 给出的地址
- Content type：`application/json`
- Secret：按 Greasy Fork 提示填写
- SSL verification：Enable
- 触发事件：Just the push event

这样每次 push 后 Greasy Fork 会立即同步，而不是等定时检查。

### 4. 用户从哪里安装

- **Greasy Fork 脚本页**：<https://greasyfork.org/zh-CN/scripts/565101>，用户从 Greasy Fork 安装和更新。
- **GitHub raw 链接**：直接把 raw 链接发给别人，对方从 GitHub 安装；更新来源是 GitHub，不经过 Greasy Fork。

两者不要混用：如果用户从 Greasy Fork 安装，就让他们继续用 Greasy Fork 的脚本页。

Greasy Fork 会自动写入自己的 `@downloadURL` / `@updateURL`；脚本头里不要加外部更新地址，否则用户可能绕过 Greasy Fork 去 GitHub 检查更新。

## Greasyfork 检查项

- `@license MIT`：已添加，仓库内也有 `LICENSE` 文件。
- `@match`：`https://*.pc.xiaoe-tech.com/p/t_pc/course_pc_detail/video/*`，覆盖所有小鹅通 PC 租户。
  - Greasy Fork 可能仍提示子域名通配符；这是建议，不是拒绝，域名已经限定在小鹅通平台。
  - 如果只想覆盖自己的租户，可以改成具体子域名，例如 `https://<你的租户>.pc.xiaoe-tech.com/...`，但其他人就无法使用。
  - 不要使用 `*://*`。
- 「附加信息」建议填写：

```text
小鹅通 PC 课程播放页增强：
1. 16:9 播放器布局，隐藏标签区和右侧推荐；
2. 复用站点原图标，支持普通 / 网页宽屏 / 原生全屏三态切换；
3. 记住音量、倍速、播放形式，刷新或切换课时后恢复；
4. 控制条「选集」面板，加载完整课程目录，支持章节分组、搜索、当前课高亮、进度和直播标记。
只在课程视频播放页生效，不修改课程列表页。
```

## 开发

- 入口文件：`xet-course-layout.user.js`
- 无构建步骤；修改文件头 `@version` 和代码里的 `STYLE_VERSION`。
- 语法检查：

```bash
node --check xet-course-layout.user.js
```

或者在浏览器/Tampermonkey 中直接加载测试。

## License

[MIT](LICENSE)
