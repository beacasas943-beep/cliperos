-- ClipControl 2.6.0 - fuerza una nueva lectura de TODOS los Facebook activos.
-- NO borra views/likes/comments/shares ni videos.

insert into public.video_metric_sync_state (
  video_id,
  next_check_at,
  fail_count,
  last_error,
  last_manual_at,
  pending_correction,
  updated_at
)
select
  v.id,
  now() - interval '1 minute',
  0,
  null,
  null,
  '{}'::jsonb,
  now()
from public.videos v
where lower(v.platform::text) = 'facebook'
  and v.deleted_at is null
on conflict (video_id) do update
set
  next_check_at = excluded.next_check_at,
  fail_count = 0,
  last_error = null,
  last_manual_at = null,
  pending_correction = '{}'::jsonb,
  updated_at = now();

update public.videos
set
  metrics_next_check_at = now() - interval '1 minute',
  metrics_error = null
where lower(platform) = 'facebook'
  and deleted_at is null;

select
  count(*) as facebook_listos_para_reintento
from public.videos
where lower(platform) = 'facebook'
  and deleted_at is null;
