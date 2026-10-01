// ── ONE DEFINITION OF "STILL MISSING" ──────────────────────────────────────────
//
// Four places ask the same question — the client's page, the developer's task, the brief prompt, and My
// Tasks — and the first version of it was wrong in a way that only showed up when all four were written:
// a required item called 'logo' was computed from sitenex_intake.fields alone, so a client who UPLOADED
// their logo was told it was still outstanding, on a task that listed the file two lines above.
//
// AN ITEM IS SATISFIED BY EITHER a non-empty answer in `fields` OR an uploaded file tagged with that
// field. Shared rather than reimplemented, for the same reason renderableFor is shared between the deals
// board and the deal form: the moment two definitions of ready drift, one of the screens is lying.

// `files` are rows carrying a `field` column (sitenex_intake_files.field).
function missingItems(required, fields, files = []) {
  const need = Array.isArray(required) ? required : [];
  const have = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
  const uploaded = new Set((files || []).map(f => f && f.field).filter(Boolean));
  return need.filter((k) => {
    if (uploaded.has(k)) return false;
    const v = have[k];
    if (v == null || v === '') return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'string') return v.trim() === '';
    return false;
  });
}

module.exports = { missingItems };
