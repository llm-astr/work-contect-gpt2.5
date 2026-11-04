import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, isAbsolute } from 'node:path';
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client';
import { tools, run } from './image-core.js';

export const name = 'yomi-image';
export const inject = { required: ['tools'], optional: ['skills'] };
export const Config = z.object({
  apiKey: z.string().role('secret').default('').description('YomiAPI API Key（输入隐藏；保存在本机 profile 配置中，并非加密保险库）。修改后下次调用生效。').volatile(),
  workspace: z.string().default(join(homedir(), 'dshwork')).description('参考图和生成图工作区，绝对路径；不自动跟随会话目录。').volatile(),
});

export function apply(ctx, config) {
  const skills = ctx.get('skills');
  if (skills) {
    const skillUrl = new URL('./skills/visual-design/', import.meta.url);
    const content = readFileSync(new URL('SKILL.md', skillUrl), 'utf8').replace(/^---[\s\S]*?---\s*/, '');
    ctx.effect(() => skills.register({
      name: 'visual-design',
      description: '实用海报与封面设计：先定版式、层级、配色和留白，再生成主视觉或使用HTML/SVG精确叠字。',
      whenToUse: '制作或改版海报、封面、宣传图、产品视觉、信息卡片，或用户希望生图更有排版与设计感时。',
      resourceBase: { kind: 'directory', path: fileURLToPath(skillUrl) },
      content,
      source: 'bundled',
      provider: 'dsh-yomi-image-mcp',
    }));
  }
  for (const tool of tools) {
    const definition = createMcpToolDefinition(ctx, {
      name: `mcp__yomi_image__${tool.name}`,
      rawName: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      async call(args, exec) {
        try {
          // Read live settings at call time; never place the key in tool arguments or status.
          const apiKey = config.apiKey.get();
          const directory = config.workspace.get();
          if (!isAbsolute(directory)) throw new Error('请在插件配置中填写工作区绝对路径。');
          const workspace = resolve(directory);
          return await run(tool.name, args, {
            apiKey, workspace, signal: exec.signal,
            async approve(request) {
              const approval = ctx.get('approval');
              if (!approval || !exec.agent) return false;
              const outcome = await approval.request({
                agent: exec.agent,
                toolName: `mcp__yomi_image__${tool.name}`,
                signal: exec.signal,
                reason: `付费 Sunburst 生图确认。模型：${request.model}；目标尺寸：${request.size || '未指定，上游自动'}。请核实这确实是用户要求的2K/4K或高分辨率，而不是模型根据比例补出的要求。提示词：${request.prompt}`,
              });
              return outcome === 'allowed-once';
            },
          });
        } catch (error) {
          // The core deliberately emits safe diagnostics without API response bodies or secrets.
          return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : '图片操作失败，未自动重试。' }] };
        }
      },
    });
    definition.timeoutMs = 660000;
    ctx.effect(() => ctx.tools.register(definition));
  }
}
