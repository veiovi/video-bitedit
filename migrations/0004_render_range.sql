-- Renders of part of a timeline (an in/out range or a range marker), and
-- stills: the rendered frames [range_start, range_end). Both NULL renders the
-- whole timeline.
ALTER TABLE renders ADD COLUMN range_start INTEGER;
ALTER TABLE renders ADD COLUMN range_end INTEGER;
