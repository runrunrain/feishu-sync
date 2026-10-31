// codemode 沙箱保留名冲突最小复现（2026-11-01 会话实测）
// 现象：脚本首行声明 const tools = ... 与沙箱全局保留名 tools 冲突
// 实际错误输出：
//   Script error:
//   SyntaxError: invalid redefinition of parameter name
//       at codemode.js:2:13
// 问题：错误信息未说明「tools 是沙箱全局保留名」，只给语法错误定位；
//       模型需猜测才能定位到换变量名（本会话耗时 1 轮）。
// 复现：把下面一行粘进 codemode 即触发（保留其余注释）：
// const tools = await searchTools("tavily", { limit: 1 });
// 正确写法（换名）：
// const found = await searchTools("tavily", { limit: 1 });
