-- 工作記錄系統 v1.2.0：節點日期來源模式
alter table public.project_schedule_nodes
  add column if not exists data_mode text not null default 'AUTO';

alter table public.project_schedule_nodes
  drop constraint if exists project_schedule_nodes_data_mode_check;

alter table public.project_schedule_nodes
  add constraint project_schedule_nodes_data_mode_check
  check (data_mode in ('AUTO','MANUAL'));

-- 既有已填日期無法判斷是否由系統或使用者建立，優先保護使用者資料。
update public.project_schedule_nodes
set data_mode = 'MANUAL'
where planned_start_date is not null
   or planned_end_date is not null
   or actual_start_date is not null
   or actual_end_date is not null;

comment on column public.project_schedule_nodes.data_mode is
  'AUTO: 可由重新計算功能推算；MANUAL: 使用者修改或清除日期後保留，不自動覆蓋。';
