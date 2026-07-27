# 工作記錄系統 v1.2.0

本版依 `02_v1.2.0功能規格.md` 完成獨立登入頁，以及上市時程日期的 AUTO／MANUAL 規則。

## v1.2.0 變更

- 新增 `login.html`，提供 Email／Password 登入與忘記密碼功能。
- 未登入時由 `index.html`、`gantt.html` 導向登入頁；登入成功後返回原功能頁。
- 密碼重設信統一導向 `login.html`。
- 每個專案節點新增 `data_mode`：`AUTO` 或 `MANUAL`。
- 第一次輸入第一節點起算日，依工作日向後推算日期。
- 第一次輸入目標上市／可出貨日，依工作日向前回推日期。
- 專案建立完成後停止自動推算；使用者修改或清除任一日期後，該節點改為 `MANUAL`。
- 新增「重新計算日期」，支援僅本節點、本節點＋後續節點、整個專案三種範圍。
- 重新計算範圍內的節點恢復為 `AUTO`。
- 甘特圖拖曳後的節點改為 `MANUAL`，並與設定頁共用同一份日期資料。
- 新增 Supabase migration，保存 `project_schedule_nodes.data_mode`。

## 主要新增檔案

- `login.html`
- `css/login.css`
- `js/login.js`
- `js/authGuard.js`
- `js/services/supabaseServiceV120.js`
- `js/modules/scheduleV120.js`
- `supabase/migrations/20260727_add_project_schedule_node_data_mode.sql`

## 資料保護原則

重新整理、重新登入、設定頁同步及甘特圖同步，都不會重新推算並覆蓋已儲存日期。只有使用者主動按下「重新計算日期」時，指定範圍才會重新依工作日計算。
