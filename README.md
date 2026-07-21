# 個人工作記錄系統 Version 1.1.0

以 Version 1.0.1 為基礎，新增獨立的跨專案甘特式時間軸。

## 啟動

1. 開啟 `index.html` 使用原工作記錄系統。
2. 點左側「跨專案時間軸」，或直接開啟 `gantt.html`。
3. 使用 Supabase 時，請先在首頁登入，再進入甘特頁。

## v1.1.0 新增檔案

- `gantt.html`
- `css/gantt.css`
- `js/modules/ganttPage.js`

## 資料庫

本版不新增資料表，也不修改既有欄位。甘特期間資料儲存在 `project_schedules.config.nodeDates` JSON 中：

- `planned_start_date`
- `planned_end_date`

因此本版不需要執行新的 SQL。
