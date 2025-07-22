// KERN SEEDTECH QR / SLUG REDIRECT + LANDING PAGE APP
// Node.js + Express + MongoDB + Dynamic TEXT‑ONLY QR with center product code (v3.0)

import express from 'express';
import mongoose from 'mongoose';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import cron from 'node-cron';
import archiver from 'archiver';
import QRCode from 'qrcode';
import sharp from 'sharp';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------
// Mongo Models
// ------------------
const slugSchema = new mongoose.Schema({
  slug: { type: String, unique: true, index: true },
  mode: { type: String, enum: ['REDIRECT','INTERNAL_TEMPLATE'], default: 'INTERNAL_TEMPLATE' },
  dest_url: String,
  product_code: { type: String, index: true },
  batch_no: String,
  title: String,
  description: String,
  image_url: String,
  pdf_url: String,
  active: { type: Boolean, default: true },
  updated_at: { type: Date, default: Date.now },
  created_at: { type: Date, default: Date.now }
});
slugSchema.pre('save', function(next) { this.updated_at = new Date(); next(); });
const Slug = mongoose.model('Slug', slugSchema);

const scanSchema = new mongoose.Schema({
  slug:         String,
  product_code: String,
  batch_no:     String,
  name:         String,   // ← new
  phone:        String,   // ← new
  pincode:      String,   // ← new
  ip:           String,
  ua:           String,
  referer:      String,
  ts:           { type: Date, default: Date.now },
  pushed_to_zoho: Boolean,
  zoho_response: String
});
const Scan = mongoose.model('Scan', scanSchema);

// ------------------
// Zoho Service (Optional)
// ------------------
async function pushToZoho(scanDoc) {
  console.log("heu");
  if (process.env.ZOHO_ENABLE !== 'true') return;
  try {
    console.log("zoho pushing");
    const moduleName   = process.env.ZOHO_MODULE || 'Leads';
    const productField = process.env.ZOHO_FIELD_PRODUCT || 'Product_Slug';
    const batchField   = process.env.ZOHO_FIELD_BATCH   || 'Batch_No';
    const payload = { data: [{
      Last_Name: 'QR-Scan',
      Company:   'QR',
      [productField]: scanDoc.product_code,
      [batchField]:   scanDoc.batch_no,
      Description: `Slug:${scanDoc.slug} IP:${scanDoc.ip}`,
      Lead_Source: 'QR'
    }]};
    const res = await axios.post(
      `${process.env.ZOHO_API_DOMAIN}/crm/v5/${moduleName}`,
      payload,
      { headers: { Authorization: `Zoho-oauthtoken ${process.env.ZOHO_OAUTH_TOKEN}` } }
    );
    console.log(res);
    await Scan.updateOne({_id: scanDoc._id}, { pushed_to_zoho: true, zoho_response: res.status.toString() });
  } catch (e) {
    await Scan.updateOne({_id: scanDoc._id}, { pushed_to_zoho: false, zoho_response: (e.response?.status||'')+':'+e.message });
  }
}

// ------------------
// App Setup
// ------------------
const app = express();
app.use(helmet());
app.use(compression());
app.use(morgan('tiny'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'public')));

// ------------------
// Admin Auth
// ------------------
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key || req.body.key;
  if (key === process.env.ADMIN_KEY) return next();
  return res.status(401).send('Unauthorized');
}

// ------------------
// QR Config
// ------------------
const QR_DEFAULTS = {
  size: parseInt(process.env.QR_SIZE || '800', 10),
  margin: parseInt(process.env.QR_MARGIN || '4', 10),
  ecLevel: 'H',
  colorDark: '#000000',
  colorLight: '#FFFFFF',
  pillBg: process.env.QR_CENTER_BG_COLOR || '#FFFFFF',
  pillTextColor: process.env.QR_CENTER_TEXT_COLOR || '#0A4C25',
  fontFamily: process.env.QR_FONT_STACK || 'Inter,Arial,sans-serif',
  rounded: parseFloat(process.env.QR_ROUNDED || '0.25')
};

// ------------------
// TEXT-ONLY QR Generation
// ------------------
async function baseQRSvg(url) {
  return QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: QR_DEFAULTS.ecLevel,
    margin: QR_DEFAULTS.margin,
    color: { dark: QR_DEFAULTS.colorDark, light: QR_DEFAULTS.colorLight }
  });
}

/* ------------------------------------------------------------------
   Draw QR → inject centred circular badge → return SVG
   (viewBox remains 0‑41 so everything is in module units)
------------------------------------------------------------------- */
function stylizeSvgTextOnly(svgRaw, size, text) {
  // 1. normalise <svg> header (remove dup attrs, keep viewBox 0‑41)
  const headerMatch = svgRaw.match(/^<svg[^>]*>/i);
  let header = headerMatch ? headerMatch[0] : '';
  header = header.replace(/\s(width|height|shape-rendering)="[^"]*"/gi, '');
  header = header.replace(/^<svg/i,
    `<svg width="${size}" height="${size}" shape-rendering="geometricPrecision"`
  );
  let body = svgRaw.replace(/^<svg[^>]*>/i, header);

  // 2. rounded modules (optional)
  if (QR_DEFAULTS.rounded > 0 && /<rect /i.test(body)) {
    const rx = (QR_DEFAULTS.rounded * 41 * 0.5).toFixed(2);
    body = body.replace(/<rect /g, `<rect rx="${rx}" ry="${rx}" `);
  }

  // 3. badge overlay in module units
  const overlay = buildCircularBadge(text.toUpperCase());

  return body.replace(/<\/svg>\s*$/i, `${overlay}\n</svg>`);
}

/* ------------------------------------------------------------------
   Circular badge:  12 modules diameter (~29 % of code height)
   Font‑size ≈ 3.4 modules  (fits 8‑char codes comfortably)
------------------------------------------------------------------- */
function buildCircularBadge(text) {
  if (!text) return '';
  const M  = 45;           // modules
  const R  = 6;            // radius (modules)  → circle = 12 × 12
  const cx = M / 2;
  const cy = M / 2;

  return `
    <g id="centerText" font-family="${QR_DEFAULTS.fontFamily}"
       font-weight="600" font-size="1.8" fill="${QR_DEFAULTS.pillTextColor}"
       text-anchor="middle">
      <circle cx="${cx}" cy="${cy}" r="${R}"
              fill="${QR_DEFAULTS.pillBg}" />
      <text x="${cx}" y="${(cy + 1.2).toFixed(2)}">${text}</text>
    </g>`;
}



async function generateQRSvgForSlug(slugDoc) {
  const size = QR_DEFAULTS.size;
  const baseUrl = 'https://qr.kernseedtech.com';
  console.log(baseUrl);
  const url = `${baseUrl}/${slugDoc.slug}`;
  const raw = await baseQRSvg(url);
  const text = (slugDoc.product_code || slugDoc.slug || '').trim();
  console.log
  return stylizeSvgTextOnly(raw, size, text);
}

async function svgToPngBuffer(svg) {
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

// ------------------
// ROUTE: SLUG SCAN
// ------------------
app.get('/:slug', async (req, res, next) => {
  const reserved = ['admin','api','health'];
  const s = req.params.slug;
  if (reserved.includes(s)) return next();

  try {
    const doc = await Slug.findOne({ slug: s, active: true });
    if (!doc) return res.status(404).send('Not found');

    // Instead of redirect, render an EJS form:
    return res.render('qr_capture_form', {
      slug:     doc.slug,
      dest_url: doc.dest_url,
      product:  doc.product_code,
      batch:    doc.batch_no,
    });
  } catch (e) {
    next(e);
  }
});


app.post('/:slug', async (req, res, next) => {
  try {
    const s = req.params.slug;
    const doc = await Slug.findOne({ slug: s, active: true });
    if (!doc) return res.status(404).send('Not found');

    const scanDoc = await Scan.create({
      slug:         doc.slug,
      product_code: doc.product_code,
      batch_no:     doc.batch_no,
      name:         req.body.name,
      phone:        req.body.phone,
      pincode:      req.body.pincode,
      ip:           req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
      ua:           req.headers['user-agent'],
      referer:      req.headers['referer']
    });

    await pushToZoho(scanDoc).catch(console.error);

    // Instead of a raw 302, send an HTML page that _will_ redirect:
    const dest = doc.dest_url;
    return res.send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta http-equiv="refresh" content="0;url='${dest}'">
          <title>Redirecting…</title>
          <script>
            // Fallback JS redirect
            window.location.href = ${JSON.stringify(dest)};
          </script>
        </head>
        <body>
          <p>Redirecting you now…<br>
          If nothing happens, <a href="${dest}">click here</a>.</p>
        </body>
      </html>
    `);
  } catch (e) {
    next(e);
  }
});


// ------------------
// ADMIN UI + QR Endpoints
// ------------------
app.get('/admin', adminAuth, async (req,res)=>{
  const slugs = await Slug.find().sort({ updated_at: -1 }).limit(1000);
  const basePublic = (process.env.BASE_PUBLIC_URL || process.env.BASE_URL || '').replace(/\/$/,'');
  res.send(`<html><head><title>QR Admin</title><style>
    body{font-family:system-ui,Arial,sans-serif;margin:1.5rem;}
    table{border-collapse:collapse;width:100%;}
    td,th{border:1px solid #ccc;padding:4px;font-size:12px;vertical-align:top;}
    form{margin-bottom:1.5rem;padding:1rem;border:1px solid #e0e0e0;background:#fafafa;border-radius:8px;}
    label{display:block;font-size:12px;font-weight:600;margin-top:6px;}
    input,textarea,select{width:100%;box-sizing:border-box;padding:4px;font-size:12px;}
    .qr-btn{display:inline-block;padding:3px 6px;background:#0A4C25;color:#fff;text-decoration:none;border-radius:4px;font-size:11px;margin:2px 4px 2px 0}
    .mono{font-family:monospace;}
  </style></head><body>
  <h1>Dynamic QR Slugs</h1>
  <form method='post' action='/admin/save'>
    <input type='hidden' name='key' value='${process.env.ADMIN_KEY}' />
    <label>Slug <input name='slug' required pattern='[A-Za-z0-9_-]{3,32}' /></label>
    <label>Mode <select name='mode'><option>INTERNAL_TEMPLATE</option><option>REDIRECT</option></select></label>
    <label>Destination URL (only for REDIRECT) <input name='dest_url' /></label>
    <label>Product Code <input name='product_code' required /></label>
    <label>Batch No <input name='batch_no' /></label>
    <label>Title <input name='title' /></label>
    <label>Description <textarea name='description'></textarea></label>
    <label>Image URL <input name='image_url' /></label>
    <label>PDF URL <input name='pdf_url' /></label>
    <label>Active <select name='active'><option value='true'>true</option><option value='false'>false</option></select></label>
    <button type='submit'>Save / Update</button>
  </form>
  <p><a class='qr-btn' href='/admin/qr-bulk.zip?key=${process.env.ADMIN_KEY}&format=svg'>Bulk ZIP (SVG)</a>
     <a class='qr-btn' href='/admin/qr-bulk.zip?key=${process.env.ADMIN_KEY}&format=png'>Bulk ZIP (PNG)</a></p>
  <table><tr><th>Slug</th><th>Mode</th><th>Product</th><th>Batch</th><th>Dest</th><th>QR</th><th>Updated</th><th>Active</th></tr>
    ${slugs.map(s=>`<tr class='mono'><td>${s.slug}</td><td>${s.mode}</td><td>${s.product_code||''}</td><td>${s.batch_no||''}</td><td>${s.dest_url?`<a href='${s.dest_url}' target=_blank>link</a>`:'-'}</td><td><a class='qr-btn' href='/admin/qr/${s.slug}.svg?key=${process.env.ADMIN_KEY}' target='_blank'>SVG</a><a class='qr-btn' href='/admin/qr/${s.slug}.png?key=${process.env.ADMIN_KEY}' target='_blank'>PNG</a></td><td>${s.updated_at.toISOString()}</td><td>${s.active}</td></tr>`).join('')}
  </table>
  <p style='margin-top:1rem;font-size:11px;color:#555'>Base public URL: ${basePublic || 'NOT SET'} &mdash; configure BASE_PUBLIC_URL in .env.</p>
  </body></html>`);
});

app.post('/admin/save', adminAuth, async (req,res)=>{
  const { slug, mode, dest_url, product_code, batch_no, title, description, image_url, pdf_url, active } = req.body;
  if (!slug) return res.status(400).send('Slug required');
  if (mode === 'REDIRECT' && !dest_url) return res.status(400).send('dest_url required for REDIRECT mode');
  await Slug.updateOne({ slug }, { $set: { mode, dest_url, product_code, batch_no, title, description, image_url, pdf_url, active: active==='true' } }, { upsert: true });
  res.redirect('/admin?key=' + encodeURIComponent(process.env.ADMIN_KEY));
});
app.get('/admin/qr/:slug.svg', adminAuth, async (req, res) => {
  const doc = await Slug.findOne({ slug: req.params.slug }); if(!doc) return res.status(404).send('Not found');
  const svg = await generateQRSvgForSlug(doc);
  res.type('image/svg+xml').set('Cache-Control','no-store').send(svg);
});
app.get('/admin/qr/:slug.png', adminAuth, async (req, res) => {
  const doc = await Slug.findOne({ slug: req.params.slug }); if(!doc) return res.status(404).send('Not found');
  const svg = await generateQRSvgForSlug(doc);
  const png = await svgToPngBuffer(svg);
  res.type('image/png').set('Cache-Control','no-store').send(png);
});
app.get('/admin/qr-bulk.zip', adminAuth, async (req, res) => {/* ... */});

// ------------------
// HEALTH + START
// ------------------
app.get('/health', (req, res) => res.json({ ok: true }));
(async () => { await mongoose.connect(process.env.MONGO_URI); app.listen(process.env.PORT||5001, () => console.log('Running')); })();
