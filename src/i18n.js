/**
 * Interface language: Arabic and English.
 *
 * Arabic is the default — this tool is built for Arabic styles and an Arabic
 * reader. English stays one click away in the header, is remembered in this
 * browser, and can be forced with `?lang=en` (which is also how the browser
 * tests pin their assertions to one language).
 *
 * Numbers stay Western digits in both languages: musicians read "4 notes" and
 * "4 نوتات" the same way, and the tests match on them.
 *
 * Conventions:
 * - `t(key, vars)` fills `{name}` placeholders, falls back to English, then
 *   to the key itself — a missing Arabic string never blanks the screen.
 * - `cnt(n, unit)` renders "4 notes" / "4 نوتات" with correct Arabic plurals
 *   (one / two / 3-10 / 11+), so call sites never branch on language.
 * - Static HTML uses `data-i18n="key"` (text), `data-i18n-aria` (aria-label),
 *   `data-i18n-title` (title) and `data-i18n-ph` (placeholder); applyI18n
 *   swaps them all and flips `lang`/`dir` on <html>.
 */

export const LANGS = ['ar', 'en'];
export const DEFAULT_LANG = 'ar';
const STORE_KEY = 'sty.lang';

const STRINGS = {
  en: {
    doc_title: 'Yamaha Style Editor — velocity, pitch and length in a .STY',
    doc_desc:
      'Inspect and edit drum-note velocity, pitch and length inside Yamaha .STY style files, with a piano roll and playback. Runs entirely in your browser.',
    app_title: 'Style Editor',
    app_tag: 'Yamaha .STY · piano roll, velocity, length · nothing leaves this device',
    lang_btn: 'عربي',
    drop_title: 'Drop a .STY file here',
    drop_sub: 'or click to browse',
    drop_note: 'Read locally with the File API. No upload, no server, no network request after load.',
    change_file: 'Change file',
    map_title: 'Variation map',
    map_legend:
      'A dot means that part sounds in that variation. Click a dot to switch the part on or off for that variation alone. Copy duplicates a variation so you can build a new one from a starting point.',
    varswhen_title: 'What plays when',
    varswhen_legend:
      'Each bar below is one variation, positioned and sized by where the file says it starts and ends. A tick means the parts that sounded during it match what the map declares.',
    lift_title: 'Lift one note',
    lift_hint: 'Change every occurrence of one note, in one step',
    play_btn: 'Play',
    stop_btn: 'Stop',
    speed_label: 'Speed',
    volume_label: 'Volume',
    preview_edit: 'Preview edit',
    audition_original: 'Audition original',
    pvary_title: 'Play one variation',
    pvary_hint: 'The bars the file itself calls that variation',
    pvary_variation: 'Variation',
    pvary_repeat: 'Repeat',
    pvary_repeat_title: 'Start it again when it ends',
    pvary_countin: 'Count-in',
    pvary_none: 'None',
    pvary_1bar: '1 bar',
    pvary_2bars: '2 bars',
    pvary_play: 'Play variation',
    varswhen_hint_line: '{occ} · {bars} · in the order the style plays them',
    varswhen_undeclared: '{n} not declared in the map ({names})',
    varswhen_silent: '{n} declared but silent here ({names})',
    varswhen_mismatch: '{n} where a declared part did not sound: {detail}',
    varswhen_worth: 'Worth knowing:',
    varswhen_all_match: 'Every variation matches what the map declares.',
    pvary_option: '{name} · {n}',
    pvary_len: '{bars}, {secs}',
    part_option: '{label} · ch {ch}',
    editor_hint_line: '{notes}{extra} · {pending}',
    ed_title: 'Editor',
    ed_part: 'Part',
    ed_snap: 'Snap',
    ed_snap_off: 'Off',
    ed_follow: 'Follow',
    ed_fit: 'Fit',
    ed_no_pending: 'No pending edits',
    ed_revert: 'Revert',
    roll_empty: 'This part has no notes.',
    hint_daw:
      'Drag a bar in the lane to set velocity · drag a note up or down to retune · drag its right edge to change length · click empty space and drag to pan · wheel to zoom, shift+wheel for height · double-click to seek',
    ops_set: 'Set',
    chip_127: '127 loud',
    chip_110: '110',
    chip_100: '100 default',
    chip_80: '80 soft',
    chip_40: '40 ghost',
    apply_to_part: 'Apply to part',
    ops_scale: 'Scale',
    ops_offset: 'Offset',
    run_btn: 'Run',
    ops_humanize: 'Humanize',
    ops_random: 'Random',
    to_word: 'to',
    ops_curve: 'Curve',
    pivot_word: 'pivot',
    before_word: 'before',
    after_word: 'after',
    ops_accent: 'Accent',
    above_word: 'above',
    by_word: 'by',
    tl_title: 'Timeline',
    parts_title: 'Parts',
    parts_hint: 'Click a row to include or exclude it from playback and from the bulk operations',
    save_title: 'Save',
    save_hint_default: 'Your original file is never modified',
    download_edited: 'Download edited .STY',
    download_original: 'Download original',
    copy_map: 'Copy the map as text',
    sel_title: 'Selection',
    sel_hint: 'Narrows the note operations and the download to a pitch range',
    lowest_pitch: 'Lowest pitch',
    highest_pitch: 'Highest pitch',
    presets_title: 'Presets',
    presets_hint: 'Stored in this browser only, never uploaded',
    preset_name_ph: 'Preset name',
    preset_save: 'Save current',
    preset_empty: 'No presets saved yet.',
    preset_title: '{v} velocity, {s} pitch/length',
    preset_default_name: 'preset {n}',
    pdet_title: 'Part details',
    pdet_hint: 'One part in one variation — changes stage like the map dots and write on download',
    pdet_dest: 'Destination channel',
    pdet_chordkey: 'Chord key',
    pdet_chordtype: 'Chord type',
    pdet_midlow: 'Middle low note',
    pdet_midhigh: 'Middle high note',
    pdet_retrigger: 'Retrigger rule',
    pdet_staged: 'Field edits staged: {n}.',
    export_json: 'Export edits as JSON',
    import_json: 'Import JSON',
    declared_title: 'Declared sections',
    bar_at: 'bar {n}',
    note_added: 'Added {pitch} at {bar}.',
    note_removed: 'Removed {pitch} at {bar}.',
    note_restored: 'Restored {pitch} at {bar}.',
    reading: 'Reading…',
    loaded_partial: 'Loaded, but {a} could not be read, so the edit will only reach {b}. Newer arrangers may play the untouched copy.',
    loaded_mapwarn: 'Loaded {n} notes. The variation map is not completely readable: {w}. Those bytes are kept as they are, but the map shown here may be incomplete.',
    loaded_ok: 'Loaded {n} notes. Pick a part, then drag in the velocity lane or the roll.',
    pvary_silent: '{len} · silent: none of the parts you have switched on play here',
    editor_hint_new: '{n} new',
    editor_hint_edited: '{n} edited',
    editor_hint_noedits: 'no edits yet',
    editor_hint_nonotes: 'no notes',
    map_note: 'Note:',
    map_staged: '{n} map change{s} staged.',
    filemeta_nocontainer: '(no SFF container)',
    tl_grid44: 'Grid uses 4/4: {note}.',
    tl_meter_sub: 'the file declares {decl}, which does not fit this file',
    tl_no_markers: 'no variation markers',
    declared_notice:
      'These names come from the original style. This export stores no section boundaries in time, so the notes above cannot be split per section - they are grouped by part.',
    ec_none: 'No pending edits',
    ec_map: '{n} map',
    ec_added: '{n} added',
    ec_removed: '{n} removed',
    ec_velocity: '{n} velocity',
    ec_pitch: '{n} pitch/length',
    save_map_write: '{n} will be written into the download',
    summary_no_match: 'No notes match',
    summary_no_match_hint: 'include a part or widen the pitch range.',
    no_notes_range: 'No notes in this part and pitch range.',
    op_applied: '{kind} applied to {n} in {part}.',
    clash_warn: '{n} now overlap on the same pitch. Saving anyway — check the result in an arranger.',
    map_leftout: 'The variation map could not be read, so the map changes were left out: {err}',
    no_map_write: 'This file has no variation map, so the map changes cannot be written.',
    stopped_reason: 'Stopped before writing: {reason}',
    storage_denied: 'Could not write to this browser’s local storage, so presets will not persist.',
    preset_applied: 'Applied preset "{name}".',
    preset_saved: 'Saved preset "{name}" to this browser.',
    edits_discarded: 'Pending edits discarded. The file in memory is untouched.',
    map_copied: 'The variation map is on the clipboard.',
    no_markers_play: 'This file records no variation markers, so there is no single variation to play.',
    playing_var: 'Playing {v}',
    playing_var_rep: 'Playing {v}, repeating',
    playing_var_countin: 'with {n} count-in',
    playing_var_stop: 'Press Stop to end it.',
    playback_failed: 'Playback failed: {err}',
    wrote_into: 'Wrote {parts} into {file}.',
    no_changes_copy: 'No changes to write, so {file} is a copy of the original.',
    write_failed: 'Could not write the file: {err}',
    exported_n: 'Exported {n} as JSON.',
    imported_of: 'Imported {hits} of {total} entries from JSON.',
    json_unreadable: 'Could not read that JSON: {err}',
    btn_play: 'Play',
    btn_pause: 'Pause',
    btn_play_var: 'Play variation',
    btn_stop_var: 'Stop variation',
    btn_playing_var: 'Playing variation',
    sec_intro: 'Intro',
    sec_fill: 'Fill In',
    sec_ending: 'Ending',
    sec_normal_ending: 'Normal Ending',
    sec_variation: 'Variation',
    sec_bridge: 'Bridge',
    sec_other: 'Other',
    mv_no_parts: 'no parts',
    mv_rename: 'Rename',
    mv_copy: 'Copy',
    mv_copy_title: 'Add a new variation with the same parts, then edit it',
    mv_delete: 'Delete',
    mv_delete_title: 'Remove this variation from the file',
    mv_prompt_name: 'Name this variation:',
    mv_confirm_delete: 'Delete "{name}" from this file?',
    mv_dot_in: 'in',
    mv_on: 'on',
    mv_off: 'off',
    mv_dot_on_title: '{part} plays in {section} — click to switch it off',
    mv_dot_off_title: '{part} does not play in {section} — click to switch it on',
    mv_map_none: 'No variation map in this file.',
    mv_map_all: 'All {n} declared.',
    mv_map_partial: 'This file declares {n}, not the full fifteen. The others were never written into it, so they cannot be edited here.',
    mv_total_line: '{vars} · {parts}',
    mv_col_variation: 'Variation',
    mv_empty_novars: 'This file declares no variations.',
    mv_cell_named: 'ch {ch} · named {names} · in {n}',
    mv_cell_plain: 'ch {ch} · in {n}',
    mv_dot_aria: '{ch} {part} in {section}: {state}',
    map_hint_line: '{vars} · {parts}',
    map_unreadable: 'This file\'s variation map could not be read: {err}',
    map_no_map_tools: 'This file has no variation map. The note tools below still work on it.',
    map_apply_failed: 'Could not apply a change:',
    clock_s: '{s}s',
    declared_by: 'declared by the style · {n}',
    tl_from_markers: '{n}, read from the file\'s markers.',
    tl_inferred: 'This file carries no variation markers, so the blocks above are inferred from where the parts change.',
    vv_tl_title: '{name}: {bars}, {notes}',
    voice_channel: 'Channel {ch}',
    tl_cell: 'Bar {b}: {n}',
    voice_ch: 'ch {ch}',
    voice_vel_avg: 'vel <b>{lo}\u2013{hi}</b> \u00b7 avg {avg}',
    sum_line1: '<b>{n}</b> notes in <b>{parts}</b>, {pitches} pitches ({preview}{more})<br>',
    sum_more: ' +{n} more',
    sum_line2: 'Velocity now {lo}\u2013{hi}, avg {avg} (was {wlo}\u2013{whi}) \u00b7 {changed} changed.',
    this_part: 'this part',
    nl_scope_all: 'Whole style',
    nl_scope_var: 'This variation only',
    nl_applies: 'Applies to',
    nl_howmuch: 'How much Louder and Softer move each occurrence, and what Set to puts it at',
    nl_spread: 'Humanise spread',
    nl_up: 'Louder',
    nl_up_desc: 'Add the value to every occurrence',
    nl_down: 'Softer',
    nl_down_desc: 'Take the value off every occurrence',
    nl_set: 'Set to',
    nl_set_desc: 'Put every occurrence at the value',
    nl_accent: 'Accent',
    nl_accent_desc: 'Add the value only where the note is already loud',
    nl_humanise: 'Humanise',
    nl_humanise_desc: 'Spread the occurrences around by the spread value',
    nl_random: 'Random',
    nl_random_desc: 'Scatter the occurrences across the whole range',
    nl_curve: 'Curve',
    nl_curve_desc: 'Louder towards the end of the variation, quieter at the start',
    nl_no_parts: 'No parts found.',
    nl_note: 'Note',
    nl_value: 'Value',
    nl_summary: '{occ} across {bars} · velocity now {lo}–{hi}, avg {avg}',
    nl_nothing_scope: 'Nothing to change in this scope.',
    nl_nothing_there: 'Nothing to change: every occurrence is already there.',
    vv_match_undeclared: 'not declared in the map',
    vv_match_silent: 'declared, but silent here',
    vv_match_partial: 'declared {declared}; {missing} did not sound',
    vv_match_ok: 'matches the map',
    vv_bar_title: '{bars}, {notes}\n{match}',
    vv_facts_line: '{bars} · {meter}',
    vv_no_bounds: 'This file has no variation markers, so the performance has no recorded variation boundaries.',
    vv_range_title: '{name}: bars at {a} to {b}',
    vv_facts: '{notes} on {parts}',
  },
  ar: {
    doc_title: 'محرر ستايلات ياماها — السرعة والنغمة والطول في ملف .STY',
    doc_desc: 'افحص وعدّل سرعة النوتات ونغمتها وطولها داخل ملفات ستايلات ياماها .STY، مع بيانو رول وتشغيل. يعمل كاملاً في متصفحك.',
    app_title: 'محرر الستايل',
    app_tag: 'ياماها .STY · بيانو رول وسرعة وطول · لا شيء يغادر جهازك',
    lang_btn: 'EN',
    drop_title: 'أفلت ملف .STY هنا',
    drop_sub: 'أو انقر للتصفح',
    drop_note: 'يُقرأ محلياً عبر المتصفح. لا رفع، لا خادم، لا اتصال بعد التحميل.',
    change_file: 'تغيير الملف',
    map_title: 'خريطة الفابوريشنات',
    map_legend: 'النقطة تعني أن هذا الصوت يعمل في هذا الفابوريشن. انقر النقطة لتشغيل الصوت أو إيقافه لهذا الفابوريشن وحده. النسخ يكرر الفابوريشن لتبني واحداً جديداً من نقطة بداية.',
    varswhen_title: 'ماذا يعزف ومتى',
    varswhen_legend: 'كل شريط بالأسفل فابوريشن واحد، موضوع ومقاس حسب ما يقوله الملف عن بدايته ونهايته. علامة الصح تعني أن الأصوات التي عزفت تطابق ما تعلنه الخريطة.',
    lift_title: 'رفع نوتة',
    lift_hint: 'غيّر كل تكرارات نوتة واحدة بخطوة واحدة',
    play_btn: 'تشغيل',
    stop_btn: 'إيقاف',
    speed_label: 'السرعة',
    volume_label: 'الصوت',
    preview_edit: 'معاينة التعديل',
    audition_original: 'سماع الأصل',
    pvary_title: 'تشغيل فابوريشن واحد',
    pvary_hint: 'المقاطع التي يسميها الملف نفسه بهذا الفابوريشن',
    pvary_variation: 'الفابوريشن',
    pvary_repeat: 'تكرار',
    pvary_repeat_title: 'إعادة التشغيل عند الانتهاء',
    pvary_countin: 'العدّ قبل البدء',
    pvary_none: 'بدون',
    pvary_1bar: 'بار واحد',
    pvary_2bars: 'باران',
    pvary_play: 'تشغيل الفابوريشن',
    varswhen_hint_line: '{occ} · {bars} · بالترتيب الذي يعزفها الستايل',
    varswhen_undeclared: '{n} غير معلنة في الخريطة ({names})',
    varswhen_silent: '{n} معلنة لكنها صامتة هنا ({names})',
    varswhen_mismatch: '{n} لم يعزف فيها صوت معلن: {detail}',
    varswhen_worth: 'يجدر معرفته:',
    varswhen_all_match: 'كل فابوريشن يطابق ما تعلنه الخريطة.',
    pvary_option: '{name} · {n}',
    pvary_len: '{bars}، {secs}',
    part_option: '{label} · قناة {ch}',
    editor_hint_line: '{notes}{extra} · {pending}',
    ed_title: 'المحرر',
    ed_part: 'الصوت',
    ed_snap: 'الالتقاط',
    ed_snap_off: 'متوقف',
    ed_follow: 'تتبع',
    ed_fit: 'ملاءمة',
    ed_no_pending: 'لا تعديلات معلقة',
    ed_revert: 'تراجع',
    roll_empty: 'لا نوتات في هذا الصوت.',
    hint_daw: 'اسحب شريطاً في المسار لضبط السرعة · اسحب النوتة للأعلى أو الأسفل لتغيير النغمة · اسحب حافتها اليمنى لتغيير الطول · انقر مساحة فارغة واسحب للتحريك · العجلة للتقريب، مع Shift للارتفاع · نقرة مزدوجة للانتقال',
    ops_set: 'ضبط',
    chip_127: '127 عالٍ',
    chip_110: '110',
    chip_100: '100 الافتراضي',
    chip_80: '80 هادئ',
    chip_40: '40 خافت',
    apply_to_part: 'تطبيق على الصوت',
    ops_scale: 'مقياس',
    ops_offset: 'إزاحة',
    run_btn: 'تنفيذ',
    ops_humanize: 'بشرنة',
    ops_random: 'عشوائي',
    to_word: 'إلى',
    ops_curve: 'منحنى',
    pivot_word: 'المحور',
    before_word: 'قبل',
    after_word: 'بعد',
    ops_accent: 'تأكيد',
    above_word: 'فوق',
    by_word: 'بمقدار',
    tl_title: 'الخط الزمني',
    parts_title: 'الأصوات',
    parts_hint: 'انقر الصف لتضمينه أو استبعاده من التشغيل والعمليات الجماعية',
    save_title: 'حفظ',
    save_hint_default: 'ملفك الأصلي لا يُمس أبداً',
    download_edited: 'تنزيل .STY المعدّل',
    download_original: 'تنزيل الأصل',
    copy_map: 'نسخ الخريطة كنص',
    sel_title: 'التحديد',
    sel_hint: 'يضيّق عمليات النوتات والتنزيل على مدى نغمي',
    lowest_pitch: 'أخفض نغمة',
    highest_pitch: 'أعلى نغمة',
    presets_title: 'الإعدادات المسبقة',
    presets_hint: 'تُحفظ في هذا المتصفح فقط، ولا تُرفع أبداً',
    preset_name_ph: 'اسم الإعداد',
    preset_save: 'حفظ الحالي',
    preset_empty: 'لا إعدادات محفوظة بعد.',
    preset_title: '{v} سرعة، {s} نغمة/طول',
    preset_default_name: 'إعداد {n}',
    pdet_title: 'تفاصيل الصوت',
    pdet_hint: 'صوت واحد في فابوريشن واحد — التغييرات تُعلّق مثل نقاط الخريطة وتُكتب عند التنزيل',
    pdet_dest: 'قناة التوجيه',
    pdet_chordkey: 'مفتاح الكورد',
    pdet_chordtype: 'نوع الكورد',
    pdet_midlow: 'أخفض نوتة وسطى',
    pdet_midhigh: 'أعلى نوتة وسطى',
    pdet_retrigger: 'قاعدة إعادة التشغيل',
    pdet_staged: 'تعديلات الحقول المعلّقة: {n}.',
    export_json: 'تصدير التعديلات JSON',
    import_json: 'استيراد JSON',
    declared_title: 'الأقسام المعلنة',
    bar_at: 'شريط {n}',
    note_added: 'أُضيفت {pitch} عند {bar}.',
    note_removed: 'حُذفت {pitch} عند {bar}.',
    note_restored: 'استُعيدت {pitch} عند {bar}.',
    reading: 'جارٍ القراءة…',
    loaded_partial: 'تم التحميل، لكن تعذّرت قراءة {a}، فسيصل التعديل إلى {b} فقط. الأجهزة الأحدث قد تعزف النسخة غير الممسوسة.',
    loaded_mapwarn: 'تم تحميل {n} نوتة. خريطة الفابوريشنات غير كاملة القراءة: {w}. هذه البايتات تُحفظ كما هي، لكن الخريطة المعروضة قد تكون ناقصة.',
    loaded_ok: 'تم تحميل {n} نوتة. اختر صوتاً، ثم اسحب في مسار السرعة أو البيانو رول.',
    pvary_silent: '{len} · صامت: لا شيء من الأصوات المفعّلة يعزف هنا',
    editor_hint_new: '{n} جديدة',
    editor_hint_edited: '{n} معدّلة',
    editor_hint_noedits: 'لا تعديلات بعد',
    editor_hint_nonotes: 'لا نوتات',
    map_note: 'ملاحظة:',
    map_staged: 'معلّق: {c}.',
    filemeta_nocontainer: '(بدون حاوية SFF)',
    tl_grid44: 'الشبكة على 4/4: {note}.',
    tl_meter_sub: 'الملف يعلن {decl} ولا يناسب هذا الملف',
    tl_no_markers: 'لا علامات فابوريشنات',
    declared_notice: 'هذه الأسماء من الستايل الأصلي. هذا الملف لا يخزّن حدود الأقسام زمنياً، فلا يمكن تقسيم النوتات بالأقسام — بل تُجمّع بالأصوات.',
    ec_none: 'لا تعديلات معلقة',
    ec_map: '{n} خريطة',
    ec_added: '{n} مضافة',
    ec_removed: '{n} محذوفة',
    ec_velocity: '{n} سرعة',
    ec_pitch: '{n} نغمة/طول',
    save_map_write: 'ستُكتب {n} في التنزيل',
    summary_no_match: 'لا نوتات مطابقة',
    summary_no_match_hint: 'أضف صوتاً أو وسّع مدى النغمات.',
    no_notes_range: 'لا نوتات في هذا الصوت وهذا المدى.',
    op_applied: 'طُبّق {kind} على {n} في {part}.',
    clash_warn: '{n} تتداخل الآن على نفس النغمة. سيُحفظ على أي حال — تحقق من النتيجة في الجهاز.',
    map_leftout: 'تعذّرت قراءة خريطة الفابوريشنات، فاستُبعدت تغييرات الخريطة: {err}',
    no_map_write: 'لا خريطة فابوريشنات في هذا الملف، فلا يمكن كتابة تغييرات الخريطة.',
    stopped_reason: 'توقف قبل الكتابة: {reason}',
    storage_denied: 'تعذّرت الكتابة في تخزين هذا المتصفح، فلن تُحفظ الإعدادات المسبقة.',
    preset_applied: 'طُبّق الإعداد "{name}".',
    preset_saved: 'حُفظ الإعداد "{name}" في هذا المتصفح.',
    edits_discarded: 'أُهملت التعديلات المعلقة. الملف في الذاكرة لم يُمس.',
    map_copied: 'خريطة الفابوريشنات في الحافظة.',
    no_markers_play: 'لا علامات فابوريشنات في هذا الملف، فلا يوجد فابوريشن واحد لتشغيله.',
    playing_var: 'يُشغَّل {v}',
    playing_var_rep: 'يُشغَّل {v} مع التكرار',
    playing_var_countin: 'مع عدّ {n}',
    playing_var_stop: 'انقر إيقاف لإنهائه.',
    playback_failed: 'فشل التشغيل: {err}',
    wrote_into: 'كُتب {parts} في {file}.',
    no_changes_copy: 'لا تغييرات للكتابة، فـ{file} نسخة من الأصل.',
    write_failed: 'تعذّرت كتابة الملف: {err}',
    exported_n: 'صُدّر {n} بصيغة JSON.',
    imported_of: 'استُورد {hits} من {total} مدخلات من JSON.',
    json_unreadable: 'تعذّرت قراءة ملف JSON: {err}',
    btn_play: 'تشغيل',
    btn_pause: 'إيقاف مؤقت',
    btn_play_var: 'تشغيل الفابوريشن',
    btn_stop_var: 'إيقاف الفابوريشن',
    btn_playing_var: 'يُشغَّل الفابوريشن',
    sec_intro: 'مقدمة',
    sec_fill: 'فاصل',
    sec_ending: 'نهاية',
    sec_normal_ending: 'نهاية عادية',
    sec_variation: 'فابوريشن',
    sec_bridge: 'جسر',
    sec_other: 'أخرى',
    mv_no_parts: 'لا أصوات',
    mv_rename: 'إعادة تسمية',
    mv_copy: 'نسخ',
    mv_copy_title: 'أضف فابوريشن جديداً بنفس الأصوات ثم عدّله',
    mv_delete: 'حذف',
    mv_delete_title: 'احذف هذا الفابوريشن من الملف',
    mv_prompt_name: 'سمِّ هذا الفابوريشن:',
    mv_confirm_delete: 'حذف "{name}" من هذا الملف؟',
    mv_dot_in: 'في',
    mv_on: 'يعمل',
    mv_off: 'متوقف',
    mv_dot_on_title: '{part} يعمل في {section} — انقر لإيقافه',
    mv_dot_off_title: '{part} لا يعمل في {section} — انقر لتشغيله',
    mv_map_none: 'لا خريطة فابوريشنات في هذا الملف.',
    mv_map_all: 'كل {n} معلنة.',
    mv_map_partial: 'يعلن هذا الملف {n} لا الخمسة عشر كاملة. البقية لم تُكتب فيه أصلاً فلا يمكن تعديلها هنا.',
    mv_total_line: '{vars} · {parts}',
    mv_col_variation: 'الفابوريشن',
    mv_empty_novars: 'لا فابوريشنات معلنة في هذا الملف.',
    mv_cell_named: 'صوت {ch} · {names} · في {n}',
    mv_cell_plain: 'صوت {ch} · في {n}',
    mv_dot_aria: '{ch} {part} في {section}: {state}',
    map_hint_line: '{vars} · {parts}',
    map_unreadable: 'تعذّرت قراءة خريطة الفابوريشنات في هذا الملف: {err}',
    map_no_map_tools: 'لا خريطة فابوريشنات في هذا الملف. أدوات النوتات بالأسفل ما زالت تعمل عليه.',
    map_apply_failed: 'تعذّر تطبيق تغيير:',
    clock_s: '{s} ث',
    declared_by: 'معلن من الستايل · {n}',
    tl_from_markers: '{n}، مقروءة من علامات الملف.',
    tl_inferred: 'لا علامات فابوريشنات في هذا الملف، فالكتل بالأعلى مستنتجة من تغيّر الأصوات.',
    vv_tl_title: '{name}: {bars}، {notes}',
    voice_channel: 'قناة {ch}',
    tl_cell: 'شريط {b}: {n}',
    voice_ch: 'قناة {ch}',
    voice_vel_avg: 'السرعة <b>{lo}\u2013{hi}</b> \u00b7 المتوسط {avg}',
    sum_line1: '<b>{n}</b> في <b>{parts}</b>، {pitches} نغمة ({preview}{more})<br>',
    sum_more: ' +{n} أخرى',
    sum_line2: 'السرعة الآن {lo}\u2013{hi}، المتوسط {avg} (كانت {wlo}\u2013{whi}) \u00b7 تغيّر {changed}.',
    this_part: 'هذا الصوت',
    nl_scope_all: 'الستايل كاملاً',
    nl_scope_var: 'هذا الفابوريشن فقط',
    nl_applies: 'ينطبق على',
    nl_howmuch: 'مقدار تحريك "أعلى" و"أخفض" لكل تكرار، وقيمة "ضبط على"',
    nl_spread: 'مدى البشرنة',
    nl_up: 'أعلى',
    nl_up_desc: 'أضف القيمة لكل تكرار',
    nl_down: 'أخفض',
    nl_down_desc: 'اطرح القيمة من كل تكرار',
    nl_set: 'ضبط على',
    nl_set_desc: 'ضع كل تكرار عند القيمة',
    nl_accent: 'تأكيد',
    nl_accent_desc: 'أضف القيمة حيث النوتة عالية أصلاً فقط',
    nl_humanise: 'بشرنة',
    nl_humanise_desc: 'وزّع التكرارات حول القيمة بمدى التشتت',
    nl_random: 'عشوائي',
    nl_random_desc: 'بعثر التكرارات على كامل المدى',
    nl_curve: 'منحنى',
    nl_curve_desc: 'أعلى نحو نهاية الفابوريشن وأخفض في البداية',
    nl_no_parts: 'لا أصوات.',
    nl_note: 'النوتة',
    nl_value: 'القيمة',
    nl_summary: '{occ} في {bars} · السرعة الآن {lo}–{hi}، المتوسط {avg}',
    nl_nothing_scope: 'لا شيء للتغيير في هذا النطاق.',
    nl_nothing_there: 'لا شيء للتغيير: كل تكرار في مكانه أصلاً.',
    vv_match_undeclared: 'غير معلن في الخريطة',
    vv_match_silent: 'معلن لكنه صامت هنا',
    vv_match_partial: 'معلن {declared}؛ لم يعزف {missing}',
    vv_match_ok: 'يطابق الخريطة',
    vv_bar_title: '{bars}، {notes}\n{match}',
    vv_facts_line: '{bars} · {meter}',
    vv_no_bounds: 'لا علامات فابوريشنات في هذا الملف، فلا حدود مسجلة للأداء.',
    vv_range_title: '{name}: البارات من {a} إلى {b}',
    vv_facts: '{notes} في {parts}',
  },
};

/** Unit words for cnt(): English singular/plural, Arabic one/two/few/many. */
const UNITS = {
  note: { en: ['note', 'notes'], ar: ['نوتة', 'نوتتان', 'نوتات', 'نوتة'] },
  bar: { en: ['bar', 'bars'], ar: ['بار', 'باران', 'بارات', 'بار'] },
  variation: { en: ['variation', 'variations'], ar: ['فابوريشن', 'فابوريشنان', 'فابوريشنات', 'فابوريشن'] },
  occurrence: { en: ['occurrence', 'occurrences'], ar: ['تكرار', 'تكراران', 'تكرارات', 'تكرار'] },
  part: { en: ['part', 'parts'], ar: ['صوت', 'صوتان', 'أصوات', 'صوت'] },
  pair: { en: ['pair', 'pairs'], ar: ['زوج', 'زوجان', 'أزواج', 'زوج'] },
  section: { en: ['section', 'sections'], ar: ['قسم', 'قسمان', 'أقسام', 'قسم'] },
  pitch: { en: ['pitch', 'pitches'], ar: ['نغمة', 'نغمتان', 'نغمات', 'نغمة'] },
  entry: { en: ['entry', 'entries'], ar: ['عنصر', 'عنصران', 'عناصر', 'عنصر'] },
  change: { en: ['change', 'changes'], ar: ['تغيير', 'تغييران', 'تغييرات', 'تغيير'] },
};

let lang = DEFAULT_LANG;

function readStored() {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

function storeLang(value) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORE_KEY, value);
  } catch {
    // Private browsing: the choice simply does not persist.
  }
}

/** Resolve the interface language: ?lang= wins, then the stored choice, then Arabic. */
export function initLang() {
  let fromUrl = null;
  try {
    if (typeof window === 'undefined') return lang;
    fromUrl = new URLSearchParams(window.location.search).get('lang');
  } catch {
    fromUrl = null;
  }
  const stored = readStored();
  const pick = [fromUrl, stored].find((v) => LANGS.includes(v));
  lang = pick ?? DEFAULT_LANG;
  applyDocumentLang();
  return lang;
}

export function getLang() {
  return lang;
}

/** Switch language now: persists, flips the page, and re-renders static chrome. */
export function setLang(next) {
  if (!LANGS.includes(next) || next === lang) return lang;
  lang = next;
  storeLang(next);
  applyDocumentLang();
  if (typeof document !== 'undefined') applyI18n(document);
  return lang;
}

function applyDocumentLang() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
}

function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, name) =>
    vars && vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
}

/** Translate a key, filling {placeholders}. Falls back to English, then the key. */
export function t(key, vars) {
  const table = STRINGS[lang] ?? {};
  const fallback = STRINGS.en ?? {};
  const template = table[key] ?? fallback[key] ?? key;
  return fill(template, vars);
}

/**
 * "4 notes" / "4 نوتات" with correct plurals in both languages.
 * Arabic: 1 نوتة، 2 نوتتان، 3-10 نوتات، 11+ نوتة.
 */
export function cnt(n, unit) {
  const table = UNITS[unit];
  if (!table) return `${n}`;
  if (lang === 'ar') {
    const [one, two, few, many] = table.ar;
    const word = n === 1 ? one : n === 2 ? two : n >= 3 && n <= 10 ? few : many;
    return `${n} ${word}`;
  }
  return `${n} ${n === 1 ? table.en[0] : table.en[1]}`;
}


/** Map a canonical section label (sections.js) onto its dictionary key. */
const SEC_KEYS = {
  Intro: 'sec_intro',
  'Fill In': 'sec_fill',
  Ending: 'sec_ending',
  'Normal Ending': 'sec_normal_ending',
  Variation: 'sec_variation',
  Bridge: 'sec_bridge',
};
export function secKey(label) {
  return SEC_KEYS[label] ?? 'sec_other';
}

/**
 * Swap every data-i18n* attribute in the document. Dynamic regions re-render
 * through the normal render path, which calls t() at render time.
 */
export function applyI18n(doc) {
  const root = doc ?? (typeof document !== 'undefined' ? document : null);
  if (!root) return;
  applyDocumentLang();
  const swap = (attr, prop) => {
    root.querySelectorAll(`[${attr}]`).forEach((el) => {
      const key = el.getAttribute(attr);
      if (key) el[prop] = t(key);
    });
  };
  swap('data-i18n', 'textContent');
  swap('data-i18n-aria', 'ariaLabel');
  swap('data-i18n-title', 'title');
  swap('data-i18n-ph', 'placeholder');
  const title = root.querySelector('title');
  if (title?.dataset?.i18n) title.textContent = t(title.dataset.i18n);
  const meta = root.querySelector('meta[name="description"][data-i18n]');
  if (meta) meta.setAttribute('content', t(meta.dataset.i18n));
}
