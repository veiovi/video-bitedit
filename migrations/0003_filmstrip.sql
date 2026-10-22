-- Filmstrip sprites for videos: JSON {frames, every, width, height} describing
-- filmstrip.jpg next to the source in R2. NULL until the uploader sends one.
ALTER TABLE assets ADD COLUMN filmstrip TEXT;
