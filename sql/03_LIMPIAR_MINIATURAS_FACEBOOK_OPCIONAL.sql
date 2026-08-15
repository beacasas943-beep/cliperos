-- OPCIONAL: úsalo solo si quieres quitar de la BD las miniaturas temporales de Facebook.
-- No toca miniaturas ya copiadas a Supabase Storage.
update public.videos
set thumbnail_url = null
where lower(platform) = 'facebook'
  and deleted_at is null
  and thumbnail_url is not null
  and (thumbnail_url ilike '%fbcdn.net%' or thumbnail_url ilike '%fbsbx.com%');
