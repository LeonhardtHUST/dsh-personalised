// commitlint 配置：沿用 Angular 约定，额外要求提交说明的 subject 至少包含一个汉字。
// 允许的 type 沿用 Angular 的清单：build ci docs feat fix perf refactor revert style test，
// 再补一个 chore——Angular 预设本身不含 chore（chore 属于 conventional 预设），
// 而本仓约定要点名支持它。

const HANZI = /\p{Script=Han}/u;

const ALLOWED_TYPES = [
  'build',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
  'chore',
];

// 本地 plugin：commitlint 支持在 plugins 数组里直接放对象，无需单独发包。
const hanziPlugin = {
  rules: {
    // 自定义规则，用法 "subject-has-hanzi": [2, "always"]。
    'subject-has-hanzi': (parsed) => {
      // subject 缺失时退回 header，避免把「没有 type」的错算到这条规则头上。
      const subject = String(parsed.subject ?? parsed.header ?? '').trim();
      if (subject.length === 0) {
        return [false, '提交说明缺少 subject：请在 type 之后写清本次改动，并至少包含一个汉字'];
      }
      if (!HANZI.test(subject)) {
        return [
          false,
          '提交说明的 subject 必须至少包含一个汉字，例如 feat(设置): 新增自定义指令',
        ];
      }
      return [true];
    },
  },
};

export default {
  extends: ['@commitlint/config-angular'],
  plugins: [hanziPlugin],
  rules: {
    'type-enum': [2, 'always', ALLOWED_TYPES],
    'subject-has-hanzi': [2, 'always'],
  },
};
