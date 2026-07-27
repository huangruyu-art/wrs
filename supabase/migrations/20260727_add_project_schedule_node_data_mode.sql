-- 工作記錄系統 v1.2.0：節點日期來源模式
-- 可重複執行；只有第一次新增欄位時，才會把既有已填日期標記為 MANUAL。
do $$
declare
  data_mode_already_exists boolean;
begin
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'project_schedule_nodes'
      and column_name = 'data_mode'
  ) into data_mode_already_exists;

  if not data_mode_already_exists then
    alter table public.project_schedule_nodes
      add column data_mode text not null default 'AUTO';

    -- 舊資料無法確認日期來源，第一次遷移時優先保護使用者已填內容。
    update public.project_schedule_nodes
    set data_mode = 'MANUAL'
    where planned_start_date is not null
       or planned_end_date is not null
       or actual_start_date is not null
       or actual_end_date is not null;
  end if;
end
$$;

alter table public.project_schedule_nodes
  drop constraint if exists project_schedule_nodes_data_mode_check;

alter table public.project_schedule_nodes
  add constraint project_schedule_nodes_data_mode_check
  check (data_mode in ('AUTO','MANUAL'));

comment on column public.project_schedule_nodes.data_mode is
  'AUTO: 可由重新計算功能推算；MANUAL: 使用者修改或清除日期後保留，不自動覆蓋。';
