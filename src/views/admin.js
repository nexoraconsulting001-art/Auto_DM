import { discountPercent, formatMoney, paiseToInput } from '../util.js';
import { ORDER_STATUSES } from '../repos/orders.js';
import { MAX_REEL_PRODUCTS } from '../repos/reels.js';
import { MAX_IMAGES } from '../repos/products.js';
import { asset } from './assets.js';
import { html, raw } from './html.js';

const FONT_URL =
  'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&display=swap';

const NAV = [
  ['dashboard', '/admin', 'Dashboard'],
  ['orders', '/admin/orders', 'Orders'],
  ['products', '/admin/products', 'Products'],
  ['categories', '/admin/categories', 'Categories'],
  ['reels', '/admin/reels', 'Reels'],
  ['customers', '/admin/customers', 'Customers'],
  ['activity', '/admin/activity', 'DM activity'],
  ['settings', '/admin/settings', 'Settings'],
];

const fmtDate = (d) =>
  new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });

export const statusChip = (status) => html`<span class="chip chip-${status}">${ORDER_STATUSES[status] || status}</span>`;

const thumb = (src, alt = '') =>
  src ? html`<img class="thumb" src="${src}" alt="${alt}" loading="lazy">` : html`<span class="thumb thumb-empty" aria-hidden="true"></span>`;

const csrfField = (csrf) => html`<input type="hidden" name="_csrf" value="${csrf}">`;

export function adminLayout({ title, active, body, csrf, flash, badges = {} }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} | Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONT_URL}">
<link rel="stylesheet" href="${asset('admin.css')}">
</head>
<body data-csrf="${csrf || ''}">
<div class="shell">
  <nav class="side" aria-label="Admin">
    <a class="side-brand" href="/admin">Store admin</a>
    <ul>
      ${NAV.map(([key, href, label]) => html`<li><a href="${href}" ${key === active ? raw('aria-current="page"') : ''}>${label}${badges[key] ? html`<span class="badge">${badges[key]}</span>` : ''}</a></li>`)}
    </ul>
    <div class="side-foot">
      <a href="/">View store</a>
      <form method="post" action="/logout">${csrfField(csrf)}<button type="submit" class="linkish">Log out</button></form>
    </div>
  </nav>
  <main class="content">
    ${flash?.ok ? html`<p class="flash ok" role="status">${flash.ok}</p>` : ''}
    ${flash?.error ? html`<p class="flash err" role="alert">${flash.error}</p>` : ''}
    ${body}
  </main>
</div>
<script src="${asset('admin.js')}" defer></script>
</body>
</html>`;
}

// ---------------------------------------------------------------- dashboard
function setupChecklist(checklist, csrf) {
  if (!checklist || checklist.dismissed) return '';
  const done = checklist.steps.filter((x) => x.done).length;
  if (done === checklist.steps.length) return '';
  return html`<section class="panel checklist" aria-labelledby="setup-title">
  <div class="panel-head">
    <div><h2 id="setup-title">Set up your store</h2><p class="hint" style="margin:4px 0 0">${done} of ${checklist.steps.length} done. Steps tick themselves off as you go.</p></div>
    <form method="post" action="/admin/checklist/dismiss">${csrfField(csrf)}<button class="linkish dark" type="submit">Hide this</button></form>
  </div>
  <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${checklist.steps.length}" aria-valuenow="${done}"><span style="width:${Math.round((done / checklist.steps.length) * 100)}%"></span></div>
  <ol class="steps-list">
    ${checklist.steps.map((x) => html`<li class="${x.done ? 'done' : ''}">
      <span class="tick" aria-hidden="true">${x.done ? '✓' : ''}</span>
      <div><strong>${x.title}</strong><p>${x.text}</p></div>
      ${x.done ? html`<span class="chip chip-live">Done</span>` : html`<a class="btn ${x === checklist.steps.find((y) => !y.done) ? 'primary' : ''}" href="${x.href}">${x.action}</a>`}
    </li>`)}
  </ol>
</section>`;
}

export function dashboardPage({ stats, reels, orders, activity, warnings, checklist, csrf }) {
  const tiles = [
    ['DMs sent', stats.dms, `${stats.dms_today} today`],
    ['Store visits', stats.visits, `${stats.visits_today} today`],
    ['Orders', stats.orders, `${stats.orders_today} today`],
    ['Revenue (confirmed)', formatMoney(stats.revenue), 'Paid, shipped and delivered'],
  ];
  return html`
<header class="page-head"><h1>Dashboard</h1><a class="btn" href="/">View your store</a></header>
${warnings.map((w) => html`<p class="flash warn">${w}</p>`)}
${setupChecklist(checklist, csrf)}
<section class="tiles">
  ${tiles.map(([label, value, sub]) => html`<div class="tile"><p class="tile-label">${label}</p><p class="tile-value">${value}</p><p class="tile-sub">${sub}</p></div>`)}
</section>

${stats.to_confirm || stats.to_ship ? html`
<section class="panel attention">
  <h2>Needs you</h2>
  <ul>
    ${stats.to_confirm ? html`<li><a href="/admin/orders?status=payment_submitted">${stats.to_confirm} order${stats.to_confirm > 1 ? 's' : ''} waiting for payment confirmation</a></li>` : ''}
    ${stats.to_ship ? html`<li><a href="/admin/orders?status=paid">${stats.to_ship} paid order${stats.to_ship > 1 ? 's' : ''} to ship</a></li>` : ''}
  </ul>
</section>` : ''}

<section class="panel">
  <div class="panel-head"><h2>Reels</h2><a href="/admin/reels">Manage reels</a></div>
  ${reels.length ? html`
  <div class="table-wrap"><table>
    <thead><tr><th>Reel</th><th class="num">Products</th><th class="num">DMs sent</th><th class="num">Store visits</th><th class="num">Orders</th><th>Status</th></tr></thead>
    <tbody>${reels.map((r) => html`<tr>
      <td><a class="row-link" href="/admin/reels/${r.ig_media_id}">${thumb(r.thumbnail_url)}<span>${r.headline || r.slug}</span></a></td>
      <td class="num">${r.product_count}</td><td class="num">${r.dm_count}</td><td class="num">${r.visit_count}</td><td class="num">${r.order_count}</td>
      <td>${r.active ? html`<span class="chip chip-live">Live</span>` : html`<span class="chip chip-off">Paused</span>`}</td>
    </tr>`)}</tbody>
  </table></div>` : html`<p class="empty">No reel stores yet. <a href="/admin/reels">Set up your first reel</a>.</p>`}
</section>

<div class="two-col">
  <section class="panel">
    <div class="panel-head"><h2>Latest orders</h2><a href="/admin/orders">All orders</a></div>
    ${orders.length ? html`<ul class="feed">${orders.map((o) => html`<li><a href="/admin/orders/${o.id}"><strong>${o.order_number}</strong> ${o.customer_name}</a><span>${formatMoney(o.total_paise)}</span>${statusChip(o.status)}</li>`)}</ul>` : html`<p class="empty">No orders yet.</p>`}
  </section>
  <section class="panel">
    <div class="panel-head"><h2>Latest comments</h2><a href="/admin/activity">All activity</a></div>
    ${activity.length ? html`<ul class="feed">${activity.map((a) => html`<li><span><strong>@${a.username || '?'}</strong> “${a.text}”</span>${resultChip(a.result)}</li>`)}</ul>` : html`<p class="empty">No comments processed yet.</p>`}
  </section>
</div>`;
}

// ---------------------------------------------------------------- products
export function productsPage({ products, search, status, categories = [], category = 0 }) {
  const tabs = [['all', 'All'], ['active', 'Active'], ['featured', 'Featured'], ['archived', 'Archived']];
  return html`
<header class="page-head"><h1>Products</h1><a class="btn primary" href="/admin/products/new">Add product</a></header>
<form class="filters" method="get">
  <div class="tabs">${tabs.map(([k, label]) => html`<a href="?status=${k}&search=${encodeURIComponent(search)}&category=${category || ''}" ${status === k ? raw('aria-current="true"') : ''}>${label}</a>`)}</div>
  <input type="hidden" name="status" value="${status}">
  ${categories.length ? html`<select name="category" aria-label="Category" data-autosubmit>
    <option value="">All categories</option>
    ${categories.map((c) => html`<option value="${c.id}" ${Number(category) === c.id ? raw('selected') : ''}>${c.name}</option>`)}
  </select>` : ''}
  <input type="search" name="search" value="${search}" placeholder="Search products" aria-label="Search products">
</form>
${products.length ? html`
<div class="table-wrap"><table>
  <thead><tr><th>Product</th><th class="num">Price</th><th class="num">Stock</th><th class="num">In reels</th><th>Status</th></tr></thead>
  <tbody>${products.map((p) => html`<tr>
    <td><a class="row-link" href="/admin/products/${p.id}">${thumb(p.images[0], p.name)}<span>${p.name}${p.featured ? html` <span class="chip chip-new">Featured</span>` : ''}${p.category_names?.length ? html`<small>${p.category_names.join(', ')}</small>` : ''}${p.option_values.length ? html`<small>${p.option_label}: ${p.option_values.join(', ')}</small>` : ''}</span></a></td>
    <td class="num">${formatMoney(p.price_paise)}${p.mrp_paise > p.price_paise ? html`<small><s>${formatMoney(p.mrp_paise)}</s></small>` : ''}</td>
    <td class="num">${p.stock == null ? 'Unlimited' : p.stock === 0 ? html`<span class="warn-text">Sold out</span>` : p.stock}</td>
    <td class="num">${p.reel_count}</td>
    <td>${p.active ? html`<span class="chip chip-live">Active</span>` : html`<span class="chip chip-off">Archived</span>`}</td>
  </tr>`)}</tbody>
</table></div>` : html`<div class="empty-block"><p>${search ? 'No products match your search.' : 'Your catalog is empty.'}</p><a class="btn primary" href="/admin/products/new">Add your first product</a></div>`}`;
}

export function productValues(p) {
  return p
    ? {
        name: p.name, description: p.description, price: paiseToInput(p.price_paise), mrp: paiseToInput(p.mrp_paise),
        option_label: p.option_label, option_values: p.option_values.join(', '), stock: p.stock ?? '', active: p.active,
        images: p.images, featured: p.featured, categoryIds: p.category_ids || [],
      }
    : { name: '', description: '', price: '', mrp: '', option_label: 'Size', option_values: '', stock: '', active: true, images: [], featured: false, categoryIds: [] };
}

export function productFormPage({ product, values, csrf, categories = [] }) {
  const v = values;
  const images = [].concat(v.images || []);
  const inCats = new Set([].concat(v.categoryIds || []).map(Number));
  return html`
<header class="page-head">
  <div><a class="back" href="/admin/products">Products</a><h1>${product ? product.name : 'Add product'}</h1></div>
  ${product?.active ? html`<a class="btn" href="/p/${product.slug}">View in store</a>` : ''}
</header>
<form class="form-grid" method="post" action="${product ? `/admin/products/${product.id}` : '/admin/products'}">
  ${csrfField(csrf)}
  <section class="panel">
    <h2>Details</h2>
    <label>Name<input name="name" value="${v.name}" required maxlength="120"></label>
    <label>Description <span class="hint">Shown on the product page. Leave a blank line between paragraphs.</span><textarea name="description" rows="5">${v.description}</textarea></label>
    <div class="row2">
      <label>Price (₹)<input name="price" value="${v.price}" inputmode="decimal" required placeholder="1299"></label>
      <label>MRP (₹) <span class="hint">Optional, shown crossed out</span><input name="mrp" value="${v.mrp}" inputmode="decimal" placeholder="1999"></label>
    </div>
  </section>

  <section class="panel">
    <h2>Photos</h2>
    <p class="hint">Up to ${MAX_IMAGES}. The first photo is used on product cards. Upload files or paste image links.</p>
    <ul class="image-list" data-images data-max="${MAX_IMAGES}">
      ${images.map((src) => imageItem(src))}
    </ul>
    <div class="image-add">
      <label class="btn">Upload photos<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple data-upload hidden></label>
      <div class="url-add"><input type="url" placeholder="https://…/photo.jpg" aria-label="Image link" data-image-url><button type="button" class="btn" data-add-url>Add link</button></div>
    </div>
    <p class="hint" data-image-status role="status"></p>
    <template data-image-template>${imageItem('')}</template>
  </section>

  <section class="panel">
    <h2>Options and stock</h2>
    <div class="row2">
      <label>Option name <span class="hint">e.g. Size or Colour</span><input name="option_label" value="${v.option_label}" maxlength="30"></label>
      <label>Choices <span class="hint">Comma-separated. Leave empty if none.</span><input name="option_values" value="${v.option_values}" placeholder="S, M, L, XL"></label>
    </div>
    <label class="narrow">Stock <span class="hint">Leave empty for unlimited</span><input name="stock" value="${v.stock}" inputmode="numeric"></label>
    <label class="check"><input type="checkbox" name="active" ${v.active ? raw('checked') : ''}> Show in stores (uncheck to archive)</label>
  </section>

  <section class="panel">
    <h2>Where it shows</h2>
    <input type="hidden" name="categories_sent" value="1">
    ${categories.length ? html`<p class="hint">Pick the categories shoppers can find it in.</p>
    <div class="check-grid">${categories.map((c) => html`<label class="check"><input type="checkbox" name="categoryIds" value="${c.id}" ${inCats.has(c.id) ? raw('checked') : ''}> ${c.name}${c.visible ? '' : html` <small>(hidden)</small>`}</label>`)}</div>`
      : html`<p class="hint">No categories yet. <a href="/admin/categories/new">Add a category</a> to group products in the shop.</p>`}
    <label class="check"><input type="checkbox" name="featured" ${v.featured ? raw('checked') : ''}> Featured: show in “Today’s best deals” on the home page</label>
  </section>

  <div class="form-actions">
    <button class="btn primary" type="submit">${product ? 'Save product' : 'Add product'}</button>
    <a class="btn" href="/admin/products">Cancel</a>
  </div>
</form>
${product ? html`
<form class="danger-zone" method="post" action="/admin/products/${product.id}/delete" data-confirm="Delete ${product.name}? This can’t be undone.">
  ${csrfField(csrf)}
  <button class="btn danger" type="submit">Delete product</button>
</form>` : ''}`;
}

function imageItem(src) {
  return html`<li class="image-item">
    <img src="${src}" alt="">
    <input type="hidden" name="images" value="${src}">
    <div class="image-tools">
      <button type="button" class="icon" data-move="-1" aria-label="Move earlier">↑</button>
      <button type="button" class="icon" data-move="1" aria-label="Move later">↓</button>
      <button type="button" class="icon" data-remove-image aria-label="Remove photo">✕</button>
    </div>
  </li>`;
}

// ---------------------------------------------------------------- reels
export function reelsPage({ posts, postsError, reels }) {
  const configured = new Map(reels.map((r) => [r.ig_media_id, r]));
  const seen = new Set();
  const cards = posts.map((p) => {
    seen.add(p.id);
    return { id: p.id, thumb: p.thumbnail_url || p.media_url, caption: p.caption || '', date: p.timestamp, type: p.media_product_type === 'REELS' ? 'Reel' : 'Post', reel: configured.get(p.id) };
  });
  // Reels set up earlier that didn't come back from Instagram (older posts, or API down).
  for (const r of reels) {
    if (!seen.has(r.ig_media_id)) cards.push({ id: r.ig_media_id, thumb: r.thumbnail_url, caption: r.caption, date: r.created_at, type: 'Reel', reel: r });
  }
  return html`
<header class="page-head"><h1>Reels</h1></header>
<p class="lead">Each reel gets its own store with 1 to ${MAX_REEL_PRODUCTS} products. When someone comments the reel’s keyword, they get a DM with a button to that store.</p>
${postsError ? html`<p class="flash warn">Couldn’t load your Instagram posts: ${postsError}. Reels you already set up are still listed.</p>` : ''}
${cards.length ? html`
<ul class="reel-cards">
  ${cards.map((c) => html`<li class="reel-card">
    <a href="/admin/reels/${c.id}">
      ${c.thumb ? html`<img src="${c.thumb}" alt="" loading="lazy">` : html`<span class="reel-card-empty"></span>`}
      <span class="reel-card-status">${c.reel ? (c.reel.active ? html`<span class="chip chip-live">Live</span>` : html`<span class="chip chip-off">Paused</span>`) : html`<span class="chip chip-new">Not set up</span>`}</span>
    </a>
    <div class="reel-card-body">
      <p class="reel-card-title">${c.reel?.headline || c.caption.slice(0, 70) || `${c.type} ${c.id}`}</p>
      ${c.reel
        ? html`<p class="reel-card-meta">${c.reel.product_count} products, ${c.reel.dm_count} DMs, ${c.reel.order_count} orders</p>`
        : html`<p class="reel-card-meta">${c.type}${c.date ? `, ${new Date(c.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}</p>`}
      <a class="btn ${c.reel ? '' : 'primary'}" href="/admin/reels/${c.id}">${c.reel ? 'Edit store' : 'Set up store'}</a>
    </div>
  </li>`)}
</ul>` : html`<p class="empty">No posts found. Post a reel on Instagram, then refresh this page.</p>`}`;
}

export function reelValues(reel, post) {
  if (reel) {
    return {
      headline: reel.headline, slug: reel.slug, keywords: reel.keywords.join(', '), dm_message: reel.dm_message,
      button_text: reel.button_text, public_reply: reel.public_reply, active: reel.active,
      productIds: reel.products.map((p) => p.id),
    };
  }
  return {
    headline: '', slug: '', keywords: 'LINK', dm_message: 'Hey @{username}! Here’s everything from the reel 👇',
    button_text: 'Shop now', public_reply: 'Sent you a DM 📩', active: true, productIds: [],
    caption: post?.caption || '',
  };
}

export function reelFormPage({ mediaId, post, reel, products, values, baseUrl, csrf }) {
  const v = values;
  const picked = [].concat(v.productIds || []).map(Number);
  const byId = new Map(products.map((p) => [p.id, p]));
  const thumbSrc = post?.thumbnail_url || post?.media_url || reel?.thumbnail_url || '';
  const permalink = post?.permalink || reel?.permalink || '';
  const caption = post?.caption || reel?.caption || '';
  const storeLink = reel ? `${baseUrl}/r/${reel.slug}` : '';
  return html`
<header class="page-head">
  <div><a class="back" href="/admin/reels">Reels</a><h1>${reel ? 'Edit reel store' : 'Set up reel store'}</h1></div>
  ${reel ? html`<div class="head-actions">
    <button type="button" class="btn" data-copy="${storeLink}">Copy store link</button>
    <a class="btn" href="/r/${reel.slug}?preview=1" target="_blank" rel="noopener">Preview</a>
  </div>` : ''}
</header>

<div class="reel-editor">
  <aside class="reel-preview">
    ${thumbSrc ? html`<img src="${thumbSrc}" alt="Reel thumbnail">` : html`<span class="reel-card-empty"></span>`}
    ${caption ? html`<p class="caption">${caption.slice(0, 240)}</p>` : ''}
    ${permalink ? html`<a href="${permalink}" target="_blank" rel="noopener">Open on Instagram</a>` : ''}
    <p class="hint">Post ID ${mediaId}</p>
  </aside>

  <form class="form-grid" method="post" action="/admin/reels/${mediaId}" data-reel-form>
    ${csrfField(csrf)}
    <input type="hidden" name="permalink" value="${permalink}">
    <input type="hidden" name="thumbnail_url" value="${post?.thumbnail_url || post?.media_url || ''}">
    <input type="hidden" name="video_url" value="${post?.media_type === 'VIDEO' ? post.media_url || '' : ''}">
    <input type="hidden" name="caption" value="${caption.slice(0, 500)}">

    <section class="panel">
      <h2>Store page</h2>
      <label>Headline <span class="hint">Big title on the store page</span><input name="headline" value="${v.headline}" maxlength="80" placeholder="The Sunday brunch edit" required></label>
      <label>Store link <span class="hint">${baseUrl}/r/</span><input name="slug" value="${v.slug}" maxlength="60" placeholder="sunday-brunch" pattern="[a-zA-Z0-9-]*"></label>
      <label class="check"><input type="checkbox" name="active" ${v.active ? raw('checked') : ''}> Live (sends DMs and shows the store)</label>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Products</h2><span class="counter" data-counter>${picked.length} / ${MAX_REEL_PRODUCTS}</span></div>
      <p class="hint">Pick 1 to ${MAX_REEL_PRODUCTS}, in the order they appear in the reel.</p>
      <ol class="picked" data-picked data-max="${MAX_REEL_PRODUCTS}">
        ${picked.map((id) => byId.get(id)).filter(Boolean).map((p) => pickedItem(p))}
      </ol>
      <p class="empty small" data-picked-empty ${picked.length ? raw('hidden') : ''}>No products picked yet.</p>
      <details class="catalog" ${picked.length ? '' : raw('open')}>
        <summary>Add from catalog (${products.length})</summary>
        ${products.length ? html`
        <input type="search" placeholder="Search catalog" aria-label="Search catalog" data-catalog-search>
        <ul class="catalog-list" data-catalog>
          ${products.map((p) => html`<li data-name="${p.name.toLowerCase()}">
            ${thumb(p.images[0])}<span>${p.name}<small>${formatMoney(p.price_paise)}${p.active ? '' : ', archived'}</small></span>
            <button type="button" class="btn small" data-pick="${p.id}" ${picked.includes(p.id) ? raw('disabled') : ''}>Add</button>
          </li>`)}
        </ul>
        <div hidden data-picked-templates>${products.map((p) => html`<template data-for="${p.id}">${pickedItem(p)}</template>`)}</div>`
        : html`<p class="empty small">Your catalog is empty. <a href="/admin/products/new">Add a product</a> first.</p>`}
      </details>
      <p class="flash err" data-picked-error hidden role="alert"></p>
    </section>

    <section class="panel">
      <h2>Comment and DM</h2>
      <label>Keywords <span class="hint">Comma-separated. A comment containing any of these gets the DM.</span><input name="keywords" value="${v.keywords}" required placeholder="LINK, SHOP"></label>
      <label>DM message <span class="hint">{username} becomes the commenter’s name</span><textarea name="dm_message" rows="3" maxlength="600">${v.dm_message}</textarea></label>
      <div class="row2">
        <label>Button text <span class="hint">Max 20 characters</span><input name="button_text" value="${v.button_text}" maxlength="20"></label>
        <label>Public reply <span class="hint">Optional, posted under the comment</span><input name="public_reply" value="${v.public_reply}" maxlength="200"></label>
      </div>
    </section>

    <div class="form-actions">
      <button class="btn primary" type="submit">${reel ? 'Save reel store' : 'Create reel store'}</button>
      <a class="btn" href="/admin/reels">Cancel</a>
    </div>
  </form>
</div>
${reel ? html`
<form class="danger-zone" method="post" action="/admin/reels/${mediaId}/delete" data-confirm="Remove this reel’s store? Comments on it will stop getting DMs. Products stay in your catalog.">
  ${csrfField(csrf)}
  <button class="btn danger" type="submit">Remove reel store</button>
</form>` : ''}`;
}

function pickedItem(p) {
  return html`<li class="picked-item" data-id="${p.id}">
    <input type="hidden" name="productIds" value="${p.id}">
    ${thumb(p.images[0])}
    <span>${p.name}<small>${formatMoney(p.price_paise)}${discountPercent(p.price_paise, p.mrp_paise) ? `, ${discountPercent(p.price_paise, p.mrp_paise)}% off` : ''}${p.active ? '' : ', archived (hidden from store)'}</small></span>
    <div class="image-tools">
      <button type="button" class="icon" data-move="-1" aria-label="Move up">↑</button>
      <button type="button" class="icon" data-move="1" aria-label="Move down">↓</button>
      <button type="button" class="icon" data-unpick aria-label="Remove ${p.name}">✕</button>
    </div>
  </li>`;
}

// ---------------------------------------------------------------- orders
export function ordersPage({ orders, status, search }) {
  const tabs = [['', 'All'], ...Object.entries(ORDER_STATUSES)];
  return html`
<header class="page-head"><h1>Orders</h1></header>
<form class="filters" method="get">
  <div class="tabs">${tabs.map(([k, label]) => html`<a href="?status=${k}&search=${encodeURIComponent(search)}" ${status === k ? raw('aria-current="true"') : ''}>${label}</a>`)}</div>
  <input type="hidden" name="status" value="${status}">
  <input type="search" name="search" value="${search}" placeholder="Order no., name or phone" aria-label="Search orders">
</form>
${orders.length ? html`
<div class="table-wrap"><table>
  <thead><tr><th>Order</th><th>Placed</th><th>Customer</th><th class="num">Items</th><th class="num">Total</th><th>Status</th></tr></thead>
  <tbody>${orders.map((o) => html`<tr>
    <td><a href="/admin/orders/${o.id}"><strong>${o.order_number}</strong></a></td>
    <td>${fmtDate(o.created_at)}</td>
    <td>${o.customer_name}<small>${o.city}</small></td>
    <td class="num">${o.item_count}</td>
    <td class="num">${formatMoney(o.total_paise)}</td>
    <td>${statusChip(o.status)}</td>
  </tr>`)}</tbody>
</table></div>` : html`<p class="empty">${status || search ? 'No orders match.' : 'No orders yet. They’ll appear here as soon as someone checks out.'}</p>`}`;
}

export function orderDetailPage({ order, reel, csrf, storeName }) {
  const waText = `Hi ${order.customer_name.split(' ')[0]}, this is ${storeName} about your order ${order.order_number}.`;
  return html`
<header class="page-head">
  <div><a class="back" href="/admin/orders">Orders</a><h1>${order.order_number}</h1></div>
  ${statusChip(order.status)}
</header>
<div class="two-col wide-left">
  <section class="panel">
    <h2>Items</h2>
    <ul class="lines">${order.items.map((it) => html`<li>${thumb(it.image)}<span>${it.name}${it.option_value ? html`<small>${it.option_value}</small>` : ''}<small>${formatMoney(it.price_paise)} × ${it.qty}</small></span><strong>${formatMoney(it.price_paise * it.qty)}</strong></li>`)}</ul>
    <dl class="totals">
      <div><dt>Subtotal</dt><dd>${formatMoney(order.subtotal_paise)}</dd></div>
      <div><dt>Delivery</dt><dd>${order.shipping_paise ? formatMoney(order.shipping_paise) : 'Free'}</dd></div>
      <div class="grand"><dt>Total</dt><dd>${formatMoney(order.total_paise)}</dd></div>
    </dl>
    <p class="hint">Placed ${fmtDate(order.created_at)}${reel ? html` from <a href="/admin/reels/${reel.ig_media_id}">${reel.headline || reel.slug}</a>` : ''}${order.source === 'dm' ? ' via the DM link' : ''}.</p>
  </section>
  <div class="stack">
    <section class="panel">
      <h2>Update status</h2>
      <form method="post" action="/admin/orders/${order.id}/status" class="stack">
        ${csrfField(csrf)}
        <label>Status<select name="status">${Object.entries(ORDER_STATUSES).map(([k, label]) => html`<option value="${k}" ${order.status === k ? raw('selected') : ''}>${label}</option>`)}</select></label>
        <label>Internal note<textarea name="notes" rows="2" placeholder="e.g. UTR number, courier and tracking ID">${order.notes}</textarea></label>
        <button class="btn primary" type="submit">Save</button>
        <p class="hint">Cancelling puts the items back in stock.</p>
      </form>
    </section>
    <section class="panel">
      <h2>Customer</h2>
      <p class="addr">${order.customer_name}<br>${order.address}<br>${order.city}, ${order.state} ${order.pincode}</p>
      <p><a href="tel:+91${order.phone}">+91 ${order.phone}</a>${order.email ? html`<br><a href="mailto:${order.email}">${order.email}</a>` : ''}</p>
      <a class="btn" href="https://wa.me/91${order.phone}?text=${encodeURIComponent(waText)}" target="_blank" rel="noopener">Message on WhatsApp</a>
      <p class="hint"><a href="/order/${order.public_token}" target="_blank" rel="noopener">Customer’s order page</a></p>
    </section>
  </div>
</div>`;
}

// ---------------------------------------------------------------- activity
function resultChip(result) {
  const label = {
    sent: 'DM sent', processing: 'Sending', error: 'Failed', 'skip:no-keyword': 'No keyword', 'skip:unmapped-reel': 'Reel not set up',
    'skip:own-comment': 'Your own comment', 'skip:already-sent-to-user': 'Already sent', 'skip:malformed': 'Unreadable',
  }[result] || result;
  const cls = result === 'sent' ? 'live' : result === 'error' ? 'cancelled' : 'off';
  return html`<span class="chip chip-${cls}">${label}</span>`;
}

export function activityPage({ rows }) {
  return html`
<header class="page-head"><h1>DM activity</h1></header>
<p class="lead">Every comment Instagram sent to the server, and what happened to it. Newest first.</p>
${rows.length ? html`
<div class="table-wrap"><table>
  <thead><tr><th>Time</th><th>From</th><th>Comment</th><th>Reel</th><th>Result</th></tr></thead>
  <tbody>${rows.map((a) => html`<tr>
    <td>${fmtDate(a.created_at)}</td>
    <td>@${a.username || '?'}</td>
    <td>${a.text}${a.error ? html`<small class="warn-text">${a.error}</small>` : ''}</td>
    <td>${a.slug ? html`<a href="/admin/reels/${a.reel_id}">${a.headline || a.slug}</a>` : html`<small>${a.reel_id || ''}</small>`}</td>
    <td>${resultChip(a.result)}</td>
  </tr>`)}</tbody>
</table></div>` : html`<p class="empty">Nothing yet. Comment a reel’s keyword from a tester account and it will show up here.</p>`}`;
}

// ---------------------------------------------------------------- settings
export function settingsPage({ settings: s, connection, csrf }) {
  const money = (k) => paiseToInput(Number(s[k]));
  return html`
<header class="page-head"><h1>Settings</h1></header>
<form class="form-grid" method="post" action="/admin/settings">
  ${csrfField(csrf)}
  <section class="panel">
    <h2>Store</h2>
    <label>Store name<input name="store_name" value="${s.store_name}" required maxlength="60"></label>
    <label>Tagline<input name="tagline" value="${s.tagline}" maxlength="120"></label>
    <div class="row2">
      <label>Accent colour<input type="color" name="accent_color" value="${s.accent_color}"></label>
      <label>Logo link <span class="hint">Optional, square image</span><input type="url" name="logo_url" value="${s.logo_url}"></label>
    </div>
    <label>Instagram handle<input name="instagram_handle" value="${s.instagram_handle}" placeholder="yourshop"></label>
  </section>
  <section class="panel">
    <h2>Home and About pages</h2>
    <p class="hint">The words shoppers see first. Open your store to see the result.</p>
    <label>Small line above the title<input name="hero_kicker" value="${s.hero_kicker}" maxlength="60"></label>
    <label>Home page title<input name="hero_title" value="${s.hero_title}" maxlength="80"></label>
    <label>Home page subtitle<textarea name="hero_subtitle" rows="2" maxlength="240">${s.hero_subtitle}</textarea></label>
    <label>Why shop with us <span class="hint">One point per line, up to 5</span><textarea name="trust_points" rows="5">${s.trust_points}</textarea></label>
    <div class="row2">
      <label>Bulk order title<input name="bulk_title" value="${s.bulk_title}" maxlength="80"></label>
      <label>Bulk order text<input name="bulk_text" value="${s.bulk_text}" maxlength="200"></label>
    </div>
    <label>About page <span class="hint">Leave a blank line between paragraphs</span><textarea name="about_text" rows="6">${s.about_text}</textarea></label>
    <label class="narrow">GSTIN <span class="hint">Optional, shown in the footer</span><input name="gstin" value="${s.gstin}" maxlength="20"></label>
  </section>
  <section class="panel">
    <h2>Delivery</h2>
    <div class="row2">
      <label>Delivery fee (₹)<input name="shipping_fee" value="${money('shipping_fee_paise')}" inputmode="decimal"></label>
      <label>Free delivery from (₹) <span class="hint">0 = never free</span><input name="free_shipping_above" value="${money('free_shipping_above_paise')}" inputmode="decimal"></label>
    </div>
  </section>
  <section class="panel">
    <h2>Payment QR</h2>
    <p class="hint">Payments aren’t live yet. Customers see a demo QR with the order amount and confirm themselves; you mark orders as paid.</p>
    <div class="row2">
      <label>UPI ID shown on the QR<input name="upi_id" value="${s.upi_id}"></label>
      <label>Payee name<input name="upi_payee" value="${s.upi_payee}"></label>
    </div>
  </section>
  <section class="panel">
    <h2>Support</h2>
    <div class="row2">
      <label>WhatsApp number<input name="support_whatsapp" value="${s.support_whatsapp}" placeholder="919876543210"></label>
      <label>Email<input type="email" name="support_email" value="${s.support_email}"></label>
    </div>
  </section>
  <div class="form-actions"><button class="btn primary" type="submit">Save settings</button></div>
</form>

<section class="panel">
  <h2>Instagram connection</h2>
  <dl class="kv">
    <div><dt>Account</dt><dd>${connection.account ? `@${connection.account.username}` : html`<span class="warn-text">${connection.error || 'Not connected'}</span>`}</dd></div>
    <div><dt>Store links in DMs use</dt><dd>${connection.baseUrl}${connection.baseUrlFromEnv ? '' : html`<small class="warn-text">Guessed from this browser. Set PUBLIC_BASE_URL in .env so DMs always use the right address.</small>`}</dd></div>
    <div><dt>Webhook URL for Meta</dt><dd><code>${connection.baseUrl}/webhook</code></dd></div>
    <div><dt>Sending DMs</dt><dd>${connection.dryRun ? html`<span class="warn-text">Test mode (DRY_RUN=1): DMs are only logged</span>` : 'Live'}</dd></div>
    <div><dt>One DM per person per reel</dt><dd>${connection.oneDmPerUser ? 'On' : 'Off'}</dd></div>
    <div><dt>Database</dt><dd>${connection.database}</dd></div>
  </dl>
</section>

<section class="panel">
  <h2>Your login</h2>
  <p class="hint" style="margin:0">You log in on <a href="/login">/login</a> with the mobile number in <code>ADMIN_PHONE</code> and the password in <code>ADMIN_PASSWORD</code>. To change the password, edit <code>.env</code> and restart the app. Shoppers' passwords can be reset in <a href="/admin/customers">Customers</a>.</p>
</section>

<section class="panel">
  <h2>Demo data</h2>
  <p class="hint">Fills the store with Mehta Mart's collections and products, and sets up a store for each of your 3 newest reels: Kitchen Creations, Fresh Start Cleaning and Trending Toys. Safe to run again: existing products are reused and your settings are kept.</p>
  <form method="post" action="/admin/demo-data" data-confirm="Load demo data into your 3 newest reels? Their current store setup will be replaced.">
    ${csrfField(csrf)}
    <button class="btn" type="submit">Load demo data</button>
  </form>
</section>`;
}

// ---------------------------------------------------------------- categories
export function categoriesPage({ categories }) {
  return html`
<header class="page-head"><h1>Categories</h1><a class="btn primary" href="/admin/categories/new">Add category</a></header>
<p class="lead">Categories show as circles on the home page and as chips in the shop. Lower numbers come first.</p>
${categories.length ? html`
<div class="table-wrap"><table>
  <thead><tr><th>Category</th><th class="num">Order</th><th class="num">Products</th><th>Status</th><th></th></tr></thead>
  <tbody>${categories.map((c) => html`<tr>
    <td><a class="row-link" href="/admin/categories/${c.id}">${thumb(c.image_url, c.name)}<span>${c.name}<small>/c/${c.slug}</small></span></a></td>
    <td class="num">${c.position}</td>
    <td class="num">${c.product_count}</td>
    <td>${c.visible ? html`<span class="chip chip-live">Visible</span>` : html`<span class="chip chip-off">Hidden</span>`}</td>
    <td>${c.visible ? html`<a href="/c/${c.slug}">View</a>` : ''}</td>
  </tr>`)}</tbody>
</table></div>` : html`<div class="empty-block"><p>No categories yet.</p><a class="btn primary" href="/admin/categories/new">Add your first category</a></div>`}`;
}

export function categoryFormPage({ category, values: v, csrf, products = [] }) {
  return html`
<header class="page-head">
  <div><a class="back" href="/admin/categories">Categories</a><h1>${category ? category.name : 'Add category'}</h1></div>
  ${category?.visible ? html`<a class="btn" href="/c/${category.slug}">View in store</a>` : ''}
</header>
<form class="form-grid" method="post" action="${category ? `/admin/categories/${category.id}` : '/admin/categories'}">
  ${csrfField(csrf)}
  <section class="panel">
    <h2>Details</h2>
    <label>Name<input name="name" value="${v.name}" required maxlength="60"></label>
    <label>Short description <span class="hint">Optional, shown at the top of the category page</span><textarea name="description" rows="2" maxlength="400">${v.description}</textarea></label>
    <div class="row2">
      <label>Link name <span class="hint">/c/…, made from the name if empty</span><input name="slug" value="${v.slug}" maxlength="60"></label>
      <label>Order <span class="hint">Lower numbers show first</span><input name="position" value="${v.position}" inputmode="numeric"></label>
    </div>
    <label>Image link <span class="hint">Square photo, or upload one below</span><input name="image_url" value="${v.image_url}" data-single-image></label>
    <div class="image-add"><label class="btn">Upload image<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-upload-single hidden></label>
      ${v.image_url ? html`<img class="thumb" src="${v.image_url}" alt="" data-single-preview>` : html`<img class="thumb" alt="" data-single-preview hidden>`}</div>
    <p class="hint" data-image-status role="status"></p>
    <label class="check"><input type="checkbox" name="visible" ${v.visible ? raw('checked') : ''}> Show in the store</label>
  </section>
  <div class="form-actions">
    <button class="btn primary" type="submit">${category ? 'Save category' : 'Add category'}</button>
    <a class="btn" href="/admin/categories">Cancel</a>
  </div>
</form>
${category ? html`
<section class="panel">
  <div class="panel-head"><h2>Products in this category (${products.length})</h2><a href="/admin/products?category=${category.id}">Manage</a></div>
  ${products.length ? html`<ul class="mini-list">${products.slice(0, 30).map((p) => html`<li><a class="row-link" href="/admin/products/${p.id}">${thumb(p.images[0], p.name)}<span>${p.name}</span></a></li>`)}</ul>`
    : html`<p class="empty">No products yet. Tick this category on a product's page to add it.</p>`}
</section>
<form class="danger-zone" method="post" action="/admin/categories/${category.id}/delete" data-confirm="Delete ${category.name}? Its products stay in your catalog.">
  ${csrfField(csrf)}
  <button class="btn danger" type="submit">Delete category</button>
</form>` : ''}`;
}

export const categoryValues = (c) =>
  c ? { name: c.name, slug: c.slug, description: c.description, image_url: c.image_url, position: c.position, visible: c.visible }
    : { name: '', slug: '', description: '', image_url: '', position: 0, visible: true };

// ---------------------------------------------------------------- customers
export function customersPage({ customers, search, csrf, resetFor = null }) {
  return html`
<header class="page-head"><h1>Customers</h1></header>
<p class="lead">Shoppers who created an account. Guest orders still show in Orders. If someone forgets their password, set a new one here and send it to them.</p>
${resetFor ? html`<p class="flash ok" role="status">New password for ${resetFor.name} (${resetFor.phone}): <code>${resetFor.password}</code>. Send it to them on WhatsApp; they can change it in My account.</p>` : ''}
<form class="filters" method="get"><input type="search" name="search" value="${search}" placeholder="Search by name or number" aria-label="Search customers"></form>
${customers.length ? html`
<div class="table-wrap"><table>
  <thead><tr><th>Customer</th><th>Mobile</th><th class="num">Orders</th><th class="num">Spent</th><th>Joined</th><th></th></tr></thead>
  <tbody>${customers.map((u) => html`<tr>
    <td>${u.name}${u.role === 'owner' ? html` <span class="chip chip-new">Owner</span>` : ''}${u.email ? html`<small>${u.email}</small>` : ''}</td>
    <td><a href="https://wa.me/91${u.phone}">${u.phone}</a></td>
    <td class="num">${u.order_count ? html`<a href="/admin/orders?search=${u.phone}">${u.order_count}</a>` : 0}</td>
    <td class="num">${formatMoney(Number(u.spent))}</td>
    <td>${new Date(u.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
    <td>${u.role !== 'customer' ? '' : html`<form method="post" action="/admin/customers/${u.id}/reset" data-confirm="Set a new password for ${u.name}?">${csrfField(csrf)}<button class="btn" type="submit">Reset password</button></form>`}</td>
  </tr>`)}</tbody>
</table></div>` : html`<p class="empty">${search ? 'No customers match.' : 'No customer accounts yet. Shoppers can sign up, or add a password when they check out.'}</p>`}`;
}
