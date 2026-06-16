import { z } from "zod";
import { getSkillDefinition } from "../../skills/registry.js";
import { getSkillState, listSkillStates } from "../../skills/state.js";
import type { ToolModule } from "../types.js";

const getAgentSkillSchema = z.object({
  skillId: z.string().min(1).max(80)
});

export const skillTools: ToolModule[] = [
  {
    definition: {
      name: "list_agent_skills",
      description: "List local built-in agent skill packs and whether each one is enabled from Admin.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: z.object({}).optional().default({}),
    handler: () => {
      const skills = listSkillStates().map(({ protocolMarkdown: _protocolMarkdown, ...skill }) => skill);
      return {
        ok: true,
        summary: `Listed ${skills.length} agent skill(s).`,
        artifacts: [],
        logs: [JSON.stringify({ skills }, null, 2)],
        structuredContent: { skills },
        errors: []
      };
    }
  },
  {
    definition: {
      name: "get_agent_skill",
      description: "Return one local agent skill pack's SOP/protocol and exposed MCP tool names.",
      inputSchema: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "Skill id from list_agent_skills." }
        },
        required: ["skillId"],
        additionalProperties: false
      }
    },
    enabledByDefault: true,
    schema: getAgentSkillSchema,
    handler: (input) => {
      const parsed = input as z.infer<typeof getAgentSkillSchema>;
      const definition = getSkillDefinition(parsed.skillId);
      const state = getSkillState(parsed.skillId);
      if (!definition || !state) {
        return {
          ok: false,
          summary: `Unknown agent skill: ${parsed.skillId}`,
          artifacts: [],
          logs: [],
          errors: [`Unknown agent skill: ${parsed.skillId}`]
        };
      }
      const skill = {
        ...state,
        toolNames: definition.toolNames
      };
      return {
        ok: true,
        summary: `Loaded agent skill ${definition.id}.`,
        artifacts: [],
        logs: [state.protocolMarkdown],
        structuredContent: { skill },
        errors: []
      };
    }
  }
];
