-- A post id is unique on Instagram and Facebook, but a business writing one down is no proof that the post is theirs (D-5).
-- With ig_media_id as the whole key, whoever wrote an id first held it for every business, and the account that posted
-- it was locked out of its own reel and landing page. Each business now keys its own rows, so another business's row
-- can never stand in the way. Whether a post is the business's own is checked against its own connected account when a
-- reel or page is created (src/modules/admin-api/reels.js, src/modules/pages/api.js).
-- Every reference to a reel already names the business: (tenant_id, ig_media_id) or (tenant_id, id).
ALTER TABLE reel_products DROP CONSTRAINT reel_products_pkey;
ALTER TABLE reel_products ADD PRIMARY KEY (tenant_id, reel_id, product_id);

ALTER TABLE reels DROP CONSTRAINT reels_pkey;
ALTER TABLE reels ADD PRIMARY KEY (tenant_id, ig_media_id);
