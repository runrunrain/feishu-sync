// ESLint 9 flat config（工程治理 G1 引入）。
// 职责边界：只抓代码质量问题（未用变量、可疑比较、类型误用等），
// 不做格式检查——格式由 prettier 基准渐进采纳，避免全仓一次性重排噪声。
// 遗留问题策略：先以最小规则集落地（js recommended + ts recommended，
// 非 type-aware），历史文件违规清零后才进入 CI；后续收紧需独立评估。
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist*/**',
      'server/dist/**',
      'release*/**',
      'build/**',
      'amagi-task/**',
      '.amagi-worktrees/**',
      'projects-memory/**',
      'docs/**',
      'server/tests/fixtures/**',
      'server/scripts/**',
      'scripts/**',
      '*.cjs',
      '**/*.cjs',
      '**/*.mjs',
      '**/*.config.{js,ts}',
      'eslint.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // 类型安全类（no-explicit-any 等）历史代码未清零，先不启用 error；
      // typecheck 已由 tsc --noEmit（strict）全量覆盖。
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        // ignoreRestSiblings：React 组件解构排除模式
        // （如 `{ className = '', ...props }` 刻意不透传 className）是
        // 本仓库既有惯例，不算未使用变量。
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // 文件名/HTML 实体处理正则里有意匹配控制字符
      // （如 Windows 非法文件名预检 /[/\\:*?"<>|\u0000-\u001f]/），关规则。
      'no-control-regex': 'off',
    },
  },
  {
    // React 代码 hooks 依赖检查：源码中已存在 5 处本规则的 disable 注释，
    // 说明该插件是历史配置的一部分，此处恢复接通。
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // server 测试遗留 `const { x } = require('...')` 写法依赖 vitest 的
    // SSR transform CJS interop，运行合法；渐进迁移，不强制重写。
    files: ['server/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
)
