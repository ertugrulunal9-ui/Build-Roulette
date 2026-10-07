-- Build Roulette (T-024, M5): a third job kind for moderation takedowns.
--
-- A takedown deletes a build's screenshot (`screenshots/{battle}/{build}.*`). SQL cannot
-- delete Storage objects (a trigger on storage.objects blocks it, and a row delete would
-- leave the file behind), so the capture-worker does it through the Storage API, like the
-- destroy job. `jobs.ref_id` is the build id for this kind, as for `capture`.
--
-- In its own file: Postgres cannot use a new enum value in the transaction that adds it,
-- and the next migrations compare against 'takedown'.
alter type public.job_kind add value if not exists 'takedown';
