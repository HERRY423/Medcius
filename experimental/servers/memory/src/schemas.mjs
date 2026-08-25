// JSON Schema definitions for Memory MCP tools

export const TOOLS = {
  remember: {
    description: "存储一条临床经验、机构知识或工作流配置到 Agent 长期记忆库",
    inputSchema: {
      type: "object",
      required: ["scope", "key", "content"],
      properties: {
        scope: {
          type: "string",
          enum: ["hospital", "department", "doctor", "workflow", "general"],
          description: "记忆作用域",
        },
        scope_id: {
          type: "string",
          description: "作用域标识符 (如医生工号 DOC-001 或科室名称 心内科)",
        },
        key: {
          type: "string",
          description: "记忆键名 (如 preferred_antibiotic_protocol, ckd_dosage_preference)",
        },
        content: {
          description: "记忆内容 (可以是字符串或结构化对象)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "标签列表，便于聚类与检索",
        },
        source_ref: {
          type: "string",
          description: "记忆来源引证 (如 audit_seq:123 或 document_id:doc-456)",
        },
        confidence: {
          type: "number",
          description: "记忆置信度 (0.0 - 1.0，默认 1.0)",
        },
        expires_at: {
          type: "string",
          description: "可选过期 ISO 时间戳",
        },
      },
    },
  },

  recall: {
    description: "基于作用域和检索词从长期记忆库召回相关上下文与经验",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["hospital", "department", "doctor", "workflow", "general"],
          description: "记忆作用域 (留空则全域检索)",
        },
        scope_id: {
          type: "string",
          description: "指定作用域标识符",
        },
        query: {
          type: "string",
          description: "检索关键词或语义描述",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "按标签过滤",
        },
        limit: {
          type: "integer",
          description: "返回条数上限 (默认 10)",
        },
      },
    },
  },

  learn_from_override: {
    description: "记录药师或上级医师对系统判定的人工纠偏 (override/reject)，提取学习信号",
    inputSchema: {
      type: "object",
      required: ["event_type", "rationale"],
      properties: {
        event_type: {
          type: "string",
          enum: ["override", "reject", "agree"],
          description: "签核类型",
        },
        audit_seq: {
          type: "integer",
          description: "关联的审计链事件序号",
        },
        doctor_id: {
          type: "string",
          description: "处方开立医师工号",
        },
        department: {
          type: "string",
          description: "科室",
        },
        original_verdict: {
          type: "string",
          description: "系统原始判定 (如 FLAG 或 PASS)",
        },
        pharmacist_verdict: {
          type: "string",
          description: "药师纠偏判定 (如 PASS 或 REJECT)",
        },
        rationale: {
          type: "string",
          description: "药师填写的纠偏依据与临床考量",
        },
        rule_affected: {
          type: "string",
          description: "受影响的规则标识 (如 rule:cephalosporin_cross_allergy)",
        },
        suggested_action: {
          type: "string",
          description: "建议的系统改进动作 (如 '建议放宽此配伍限制' 或 '需增加特殊剂量豁免')",
        },
      },
    },
  },

  learning_stats: {
    description: "获取 Agent 记忆与自适应学习引擎的统计摘要与知识分布",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "可选按作用域过滤统计",
        },
      },
    },
  },
};
