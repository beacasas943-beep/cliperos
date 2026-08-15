-- Solo lectura.
select
  count(*) as facebook_videos,
  count(*) filter (where coalesce(views,0) > 0) as con_vistas,
  count(*) filter (where coalesce(likes,0) > 0) as con_likes,
  count(*) filter (where coalesce(comments,0) > 0) as con_comentarios,
  count(*) filter (where coalesce(shares,0) > 0) as con_compartidos,
  count(*) filter (where thumbnail_url is not null and thumbnail_url <> '') as con_thumbnail,
  count(*) filter (where metrics_error is not null) as con_error
from public.videos
where lower(platform) = 'facebook'
  and deleted_at is null;

select
  id,
  video_url,
  views,
  likes,
  comments,
  shares,
  metrics_status,
  metrics_source,
  metrics_error,
  metrics_meta ->> 'engine_version' as engine_version,
  metrics_meta ->> 'canonical_url' as canonical_url,
  metrics_meta -> 'attempts' as attempts,
  thumbnail_url,
  metrics_checked_at
from public.videos
where lower(platform) = 'facebook'
  and deleted_at is null
order by metrics_checked_at desc nulls last, created_at desc;
