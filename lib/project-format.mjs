export const defaultProjectFormat = Object.freeze({
  goalHeadings: Object.freeze(['项目目标', '项目定位', '目标', 'goal', 'objective']),
  progressHeadings: Object.freeze(['进展', '当前状态', 'progress', 'status', 'updates']),
  actionHeadings: Object.freeze(['下一步', '下周计划', '下周建议', '待推进', 'Short-term TODO', 'next steps', 'todo']),
  weeklySummaryNames: Object.freeze(['weekly-summary']),
  weeklyPlanHeadings: Object.freeze(['下周计划'])
});

export function normalizeProjectFormat(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('项目格式配置必须是 JSON 对象');
  for (const key of Object.keys(input)) {
    if (!(key in defaultProjectFormat)) throw new Error(`未知项目格式字段：${key}`);
  }
  const format = {};
  for (const [key, defaults] of Object.entries(defaultProjectFormat)) {
    const values = Object.hasOwn(input, key) ? input[key] : defaults;
    if (!Array.isArray(values) || values.length < 1 || values.length > 20
      || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 80 || /[\r\n]/.test(value))) {
      throw new Error(`${key} 必须包含 1–20 个单行名称`);
    }
    format[key] = values.map(value => value.trim());
    if (new Set(format[key].map(value => value.toLocaleLowerCase())).size !== format[key].length) {
      throw new Error(`${key} 不能重复`);
    }
  }
  return format;
}
