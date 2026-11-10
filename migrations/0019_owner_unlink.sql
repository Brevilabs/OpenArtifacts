-- A mistaken owner link can be removed (the admin unlink). Updates stay forbidden.
DROP TRIGGER owner_links_no_delete;
