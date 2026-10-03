export const defaultDailyFormat = Object.freeze({
  planHeading: '今日计划',
  timelineHeading: '时间线',
  priorityLabels: Object.freeze(['P1', 'P2', 'P3'])
});

export function normalizeDailyFormat(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('日报格式配置必须是 JSON 对象');
  const allowed = new Set(['planHeading', 'timelineHeading', 'priorityLabels']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`未知日报格式字段：${key}`);
  const format = { ...defaultDailyFormat, ...input };
  for (const key of ['planHeading', 'timelineHeading']) {
    if (typeof format[key] !== 'string' || !format[key].trim() || format[key].length > 80 || /[\r\n]/.test(format[key])) {
      throw new Error(`${key} 必须是单行标题`);
    }
    format[key] = format[key].trim();
  }
  if (!Array.isArray(format.priorityLabels) || format.priorityLabels.length !== 3
    || format.priorityLabels.some(label => typeof label !== 'string' || !label.trim() || label.length > 24 || /[:|\r\n]/.test(label))) {
    throw new Error('priorityLabels 必须包含三个单行标签');
  }
  format.priorityLabels = format.priorityLabels.map(label => label.trim());
  if (new Set(format.priorityLabels).size !== 3) throw new Error('priorityLabels 不能重复');
  return format;
}
