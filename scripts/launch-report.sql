-- Read-only. Edit only the two UTC dates for the desired half-open interval.
WITH reporting_window AS (
  SELECT unixepoch('2026-09-09') * 1000 AS start_ms,
         unixepoch('2026-09-10') * 1000 AS end_ms
), first_publications AS (
  SELECT COALESCE(l.account_id, d.owner) AS publisher, MIN(v.created_at) AS first_at
  FROM versions v JOIN docs d ON d.id = v.doc_id
  LEFT JOIN owner_links l ON l.external_owner = d.owner
  GROUP BY COALESCE(l.account_id, d.owner)
), events AS (
  SELECT 'first_persisted_publication' AS metric, first_at AS at_ms FROM first_publications
  UNION ALL
  SELECT 'immutable_account_link', created_at FROM owner_links
)
SELECT date(at_ms / 1000, 'unixepoch') AS utc_day, metric, COUNT(*) AS count
FROM events CROSS JOIN reporting_window
WHERE at_ms >= start_ms AND at_ms < end_ms
GROUP BY utc_day, metric
ORDER BY utc_day, metric;
