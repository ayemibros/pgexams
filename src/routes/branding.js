/** Port of branding/views.py — the public pages and the Super Admin site-branding form. */
const express = require('express');
const db = require('../db');
const { route, render, redirect, messages } = require('../web');
const accounts = require('../services/accounts');
const { saveUpload } = require('../forms');
const { strip } = require('../services/util');

const router = express.Router();

/** Public landing page — deliberately just the hero. */
route(router, 'branding:home', (req, res) => render(req, res, 'branding/home.html'));
route(router, 'branding:how_it_works', (req, res) => render(req, res, 'branding/how_it_works.html'));
route(router, 'branding:support', (req, res) => render(req, res, 'branding/support.html'));

/** Pricing and subscribing are one page now — keep old links working (permanent redirect). */
route(router, 'branding:pricing', (req, res) => res.redirect(301, '/subscribe/'));

route(router, 'branding:site_settings', async (req, res) => {
  // Site branding (school name/logo) is a Super Admin exclusive power.
  if (!req.user.is_authenticated || !req.user.is_super_admin) {
    messages.error(req, 'Access denied.');
    return redirect(res, '/');
  }
  const current = await accounts.getSiteSettings();

  if (req.method === 'POST') {
    const p = req.POST;
    const data = {
      school_name: strip(p.get('school_name', '')) || current.school_name,
      short_name: strip(p.get('short_name', '')) || current.short_name,
      logo_url: strip(p.get('logo_url', '')),
      target_institution_name: strip(p.get('target_institution_name', '')),
      shared_exam_name: strip(p.get('shared_exam_name', '')),
      shared_exam_short_name: strip(p.get('shared_exam_short_name', '')),
      primary_color: strip(p.get('primary_color', '')) || current.primary_color,
      secondary_color: strip(p.get('secondary_color', '')) || current.secondary_color,
      tagline: strip(p.get('tagline', '')),
      hero_headline: strip(p.get('hero_headline', '')),
      trust_line: strip(p.get('trust_line', '')),
      footer_note: strip(p.get('footer_note', '')),
      contact_email: strip(p.get('contact_email', '')),
      contact_phone: strip(p.get('contact_phone', '')),
      whatsapp_number: strip(p.get('whatsapp_number', '')),
      updated_at: new Date(),
    };
    const logo = req.FILES.get('logo');
    if (logo) data.logo = await saveUpload(logo, 'branding/');
    await db.update('branding_sitesettings', current.id, data);
    messages.success(req, 'Site settings saved.');
    return redirect(res, 'branding:site_settings');
  }

  return render(req, res, 'branding/site_settings_form.html', { active: 'site_settings', settings_obj: current });
}, { login: true });

module.exports = { router };
