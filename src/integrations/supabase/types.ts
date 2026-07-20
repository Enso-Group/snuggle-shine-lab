export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_usage_log: {
        Row: {
          completion_tokens: number | null
          cost_usd: number | null
          created_at: string
          duration_ms: number | null
          error_message: string | null
          http_status: number | null
          id: string
          kind: string
          meta: Json | null
          model: string | null
          prompt_tokens: number | null
          provider: string | null
          source: string | null
          status: string
          tool_name: string | null
          total_tokens: number | null
        }
        Insert: {
          completion_tokens?: number | null
          cost_usd?: number | null
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          http_status?: number | null
          id?: string
          kind: string
          meta?: Json | null
          model?: string | null
          prompt_tokens?: number | null
          provider?: string | null
          source?: string | null
          status?: string
          tool_name?: string | null
          total_tokens?: number | null
        }
        Update: {
          completion_tokens?: number | null
          cost_usd?: number | null
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          http_status?: number | null
          id?: string
          kind?: string
          meta?: Json | null
          model?: string | null
          prompt_tokens?: number | null
          provider?: string | null
          source?: string | null
          status?: string
          tool_name?: string | null
          total_tokens?: number | null
        }
        Relationships: []
      }
      bot_decisions: {
        Row: {
          chat_id: string | null
          conversation_id: string | null
          created_at: string
          data: Json
          duration_ms: number | null
          id: string
          job_id: string | null
          stage: string
          status: string
          summary: string | null
          trigger: string
        }
        Insert: {
          chat_id?: string | null
          conversation_id?: string | null
          created_at?: string
          data?: Json
          duration_ms?: number | null
          id?: string
          job_id?: string | null
          stage: string
          status?: string
          summary?: string | null
          trigger: string
        }
        Update: {
          chat_id?: string | null
          conversation_id?: string | null
          created_at?: string
          data?: Json
          duration_ms?: number | null
          id?: string
          job_id?: string | null
          stage?: string
          status?: string
          summary?: string | null
          trigger?: string
        }
        Relationships: [
          {
            foreignKeyName: "bot_decisions_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      bot_jobs: {
        Row: {
          attempts: number
          chat_id: string
          conversation_id: string | null
          created_at: string
          id: string
          kind: string
          last_error: string | null
          locked_by: string | null
          locked_until: string | null
          max_attempts: number
          payload: Json
          run_after: string
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          chat_id: string
          conversation_id?: string | null
          created_at?: string
          id?: string
          kind: string
          last_error?: string | null
          locked_by?: string | null
          locked_until?: string | null
          max_attempts?: number
          payload?: Json
          run_after?: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          chat_id?: string
          conversation_id?: string | null
          created_at?: string
          id?: string
          kind?: string
          last_error?: string | null
          locked_by?: string | null
          locked_until?: string | null
          max_attempts?: number
          payload?: Json
          run_after?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bot_jobs_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      bot_settings: {
        Row: {
          agent_config: Json
          bot_name: string
          created_at: string
          cron_secret: string | null
          enabled: boolean
          id: string
          model_fast: string | null
          model_strong: string | null
          require_approval_all: boolean
          system_prompt: string
          updated_at: string
          webhook_secret: string | null
        }
        Insert: {
          agent_config?: Json
          bot_name?: string
          created_at?: string
          cron_secret?: string | null
          enabled?: boolean
          id?: string
          model_fast?: string | null
          model_strong?: string | null
          require_approval_all?: boolean
          system_prompt?: string
          updated_at?: string
          webhook_secret?: string | null
        }
        Update: {
          agent_config?: Json
          bot_name?: string
          created_at?: string
          cron_secret?: string | null
          enabled?: boolean
          id?: string
          model_fast?: string | null
          model_strong?: string | null
          require_approval_all?: boolean
          system_prompt?: string
          updated_at?: string
          webhook_secret?: string | null
        }
        Relationships: []
      }
      chat_messages: {
        Row: {
          content: string
          created_at: string
          id: string
          role: string
          thread_id: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          role: string
          thread_id: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          role?: string
          thread_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "chat_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_threads: {
        Row: {
          created_at: string
          id: string
          mode: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          mode?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          mode?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      commands_log: {
        Row: {
          created_at: string
          id: string
          prompt: string
          result: string | null
          status: string
          target_chat_id: string
          target_name: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          prompt: string
          result?: string | null
          status?: string
          target_chat_id: string
          target_name?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          prompt?: string
          result?: string | null
          status?: string
          target_chat_id?: string
          target_name?: string | null
          user_id?: string
        }
        Relationships: []
      }
      conversations: {
        Row: {
          blocked: boolean
          blocked_at: string | null
          blocked_reason: string | null
          consecutive_outbound: number
          created_at: string
          first_inbound_at: string | null
          id: string
          inbound_count: number
          is_group: boolean
          last_message_at: string | null
          last_outbound_at: string | null
          last_outbound_body: string | null
          name: string | null
          updated_at: string
          whapi_chat_id: string
        }
        Insert: {
          blocked?: boolean
          blocked_at?: string | null
          blocked_reason?: string | null
          consecutive_outbound?: number
          created_at?: string
          first_inbound_at?: string | null
          id?: string
          inbound_count?: number
          is_group?: boolean
          last_message_at?: string | null
          last_outbound_at?: string | null
          last_outbound_body?: string | null
          name?: string | null
          updated_at?: string
          whapi_chat_id: string
        }
        Update: {
          blocked?: boolean
          blocked_at?: string | null
          blocked_reason?: string | null
          consecutive_outbound?: number
          created_at?: string
          first_inbound_at?: string | null
          id?: string
          inbound_count?: number
          is_group?: boolean
          last_message_at?: string | null
          last_outbound_at?: string | null
          last_outbound_body?: string | null
          name?: string | null
          updated_at?: string
          whapi_chat_id?: string
        }
        Relationships: []
      }
      follow_ups: {
        Row: {
          attempts: number
          chat_id: string
          conversation_id: string
          created_at: string
          due_at: string
          id: string
          last_error: string | null
          person_wa_id: string | null
          reason: string
          sent_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          chat_id: string
          conversation_id: string
          created_at?: string
          due_at: string
          id?: string
          last_error?: string | null
          person_wa_id?: string | null
          reason: string
          sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          chat_id?: string
          conversation_id?: string
          created_at?: string
          due_at?: string
          id?: string
          last_error?: string | null
          person_wa_id?: string | null
          reason?: string
          sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "follow_ups_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      group_daily_stats: {
        Row: {
          active_members: number
          bot_posts: number
          created_at: string
          date: string
          group_chat_id: string
          id: string
          left_members: number
          messages: number
          new_members: number
          post_replies: number
          updated_at: string
        }
        Insert: {
          active_members?: number
          bot_posts?: number
          created_at?: string
          date: string
          group_chat_id: string
          id?: string
          left_members?: number
          messages?: number
          new_members?: number
          post_replies?: number
          updated_at?: string
        }
        Update: {
          active_members?: number
          bot_posts?: number
          created_at?: string
          date?: string
          group_chat_id?: string
          id?: string
          left_members?: number
          messages?: number
          new_members?: number
          post_replies?: number
          updated_at?: string
        }
        Relationships: []
      }
      group_insights: {
        Row: {
          content: string
          created_at: string
          data: Json
          group_chat_id: string
          id: string
          kind: string
        }
        Insert: {
          content: string
          created_at?: string
          data?: Json
          group_chat_id: string
          id?: string
          kind?: string
        }
        Update: {
          content?: string
          created_at?: string
          data?: Json
          group_chat_id?: string
          id?: string
          kind?: string
        }
        Relationships: []
      }
      group_members: {
        Row: {
          created_at: string
          display_name: string | null
          group_chat_id: string
          id: string
          joined_at: string | null
          last_violation_at: string | null
          left_at: string | null
          removed: boolean
          updated_at: string
          violations: number
          wa_id: string
          warned_count: number
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          group_chat_id: string
          id?: string
          joined_at?: string | null
          last_violation_at?: string | null
          left_at?: string | null
          removed?: boolean
          updated_at?: string
          violations?: number
          wa_id: string
          warned_count?: number
        }
        Update: {
          created_at?: string
          display_name?: string | null
          group_chat_id?: string
          id?: string
          joined_at?: string | null
          last_violation_at?: string | null
          left_at?: string | null
          removed?: boolean
          updated_at?: string
          violations?: number
          wa_id?: string
          warned_count?: number
        }
        Relationships: []
      }
      group_profiles: {
        Row: {
          allow_reactive_posts: boolean
          audience: string | null
          chat_id: string
          content_pillars: Json
          created_at: string
          enabled: boolean
          escalation_rules: string | null
          forbidden_topics: Json
          id: string
          instructions: string | null
          kpis: string | null
          language: string
          moderation: Json
          name: string | null
          owner_dm: string | null
          posting_schedule: Json
          purpose: string | null
          reply_to_questions: boolean
          reply_when_mentioned: boolean
          rules: Json
          tone: string | null
          updated_at: string
          welcome: Json
        }
        Insert: {
          allow_reactive_posts?: boolean
          audience?: string | null
          chat_id: string
          content_pillars?: Json
          created_at?: string
          enabled?: boolean
          escalation_rules?: string | null
          forbidden_topics?: Json
          id?: string
          instructions?: string | null
          kpis?: string | null
          language?: string
          moderation?: Json
          name?: string | null
          owner_dm?: string | null
          posting_schedule?: Json
          purpose?: string | null
          reply_to_questions?: boolean
          reply_when_mentioned?: boolean
          rules?: Json
          tone?: string | null
          updated_at?: string
          welcome?: Json
        }
        Update: {
          allow_reactive_posts?: boolean
          audience?: string | null
          chat_id?: string
          content_pillars?: Json
          created_at?: string
          enabled?: boolean
          escalation_rules?: string | null
          forbidden_topics?: Json
          id?: string
          instructions?: string | null
          kpis?: string | null
          language?: string
          moderation?: Json
          name?: string | null
          owner_dm?: string | null
          posting_schedule?: Json
          purpose?: string | null
          reply_to_questions?: boolean
          reply_when_mentioned?: boolean
          rules?: Json
          tone?: string | null
          updated_at?: string
          welcome?: Json
        }
        Relationships: []
      }
      invited_emails: {
        Row: {
          created_at: string
          email: string
          invited_by: string | null
        }
        Insert: {
          created_at?: string
          email: string
          invited_by?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          invited_by?: string | null
        }
        Relationships: []
      }
      knowledge_base: {
        Row: {
          active: boolean
          content: string
          created_at: string
          id: string
          kind: string
          title: string
          updated_at: string
          url: string | null
        }
        Insert: {
          active?: boolean
          content: string
          created_at?: string
          id?: string
          kind?: string
          title: string
          updated_at?: string
          url?: string | null
        }
        Update: {
          active?: boolean
          content?: string
          created_at?: string
          id?: string
          kind?: string
          title?: string
          updated_at?: string
          url?: string | null
        }
        Relationships: []
      }
      messages: {
        Row: {
          body: string | null
          conversation_id: string
          created_at: string
          direction: string
          id: string
          raw: Json | null
          sender_id: string | null
          sender_name: string | null
          whapi_message_id: string | null
        }
        Insert: {
          body?: string | null
          conversation_id: string
          created_at?: string
          direction: string
          id?: string
          raw?: Json | null
          sender_id?: string | null
          sender_name?: string | null
          whapi_message_id?: string | null
        }
        Update: {
          body?: string | null
          conversation_id?: string
          created_at?: string
          direction?: string
          id?: string
          raw?: Json | null
          sender_id?: string | null
          sender_name?: string | null
          whapi_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      moderation_actions: {
        Row: {
          action: string
          created_at: string
          error: string | null
          group_chat_id: string
          id: string
          reasoning: string | null
          rule_violated: string | null
          status: string
          target_name: string | null
          target_wa_id: string | null
          whapi_message_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          error?: string | null
          group_chat_id: string
          id?: string
          reasoning?: string | null
          rule_violated?: string | null
          status?: string
          target_name?: string | null
          target_wa_id?: string | null
          whapi_message_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          error?: string | null
          group_chat_id?: string
          id?: string
          reasoning?: string | null
          rule_violated?: string | null
          status?: string
          target_name?: string | null
          target_wa_id?: string | null
          whapi_message_id?: string | null
        }
        Relationships: []
      }
      people: {
        Row: {
          created_at: string
          display_name: string | null
          facts: Json
          first_seen_at: string
          funnel_stage: string
          id: string
          language: string | null
          last_seen_at: string
          sentiment: string | null
          tags: string[]
          updated_at: string
          wa_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          facts?: Json
          first_seen_at?: string
          funnel_stage?: string
          id?: string
          language?: string | null
          last_seen_at?: string
          sentiment?: string | null
          tags?: string[]
          updated_at?: string
          wa_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          facts?: Json
          first_seen_at?: string
          funnel_stage?: string
          id?: string
          language?: string | null
          last_seen_at?: string
          sentiment?: string | null
          tags?: string[]
          updated_at?: string
          wa_id?: string
        }
        Relationships: []
      }
      planned_posts: {
        Row: {
          body: string | null
          created_at: string
          engagement: Json
          group_chat_id: string
          id: string
          pillar: string | null
          prompt: string | null
          reasoning: string | null
          scheduled_for: string | null
          sent_at: string | null
          slot_key: string | null
          source: string
          status: string
          updated_at: string
          whapi_message_id: string | null
        }
        Insert: {
          body?: string | null
          created_at?: string
          engagement?: Json
          group_chat_id: string
          id?: string
          pillar?: string | null
          prompt?: string | null
          reasoning?: string | null
          scheduled_for?: string | null
          sent_at?: string | null
          slot_key?: string | null
          source?: string
          status?: string
          updated_at?: string
          whapi_message_id?: string | null
        }
        Update: {
          body?: string | null
          created_at?: string
          engagement?: Json
          group_chat_id?: string
          id?: string
          pillar?: string | null
          prompt?: string | null
          reasoning?: string | null
          scheduled_for?: string | null
          sent_at?: string | null
          slot_key?: string | null
          source?: string
          status?: string
          updated_at?: string
          whapi_message_id?: string | null
        }
        Relationships: []
      }
      scheduled_approvals: {
        Row: {
          body: string
          conversation_id: string | null
          created_at: string
          decided_at: string | null
          id: string
          scheduled_message_id: string | null
          source: string
          status: string
          target_chat_id: string
          target_name: string | null
          user_id: string
        }
        Insert: {
          body: string
          conversation_id?: string | null
          created_at?: string
          decided_at?: string | null
          id?: string
          scheduled_message_id?: string | null
          source?: string
          status?: string
          target_chat_id: string
          target_name?: string | null
          user_id: string
        }
        Update: {
          body?: string
          conversation_id?: string | null
          created_at?: string
          decided_at?: string | null
          id?: string
          scheduled_message_id?: string | null
          source?: string
          status?: string
          target_chat_id?: string
          target_name?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_approvals_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_approvals_scheduled_message_id_fkey"
            columns: ["scheduled_message_id"]
            isOneToOne: false
            referencedRelation: "scheduled_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduled_messages: {
        Row: {
          body: string
          created_at: string
          day_of_week: number
          enabled: boolean
          id: string
          last_sent_at: string | null
          mode: string
          require_approval: boolean
          send_time: string
          target_chat_id: string
          target_name: string | null
          timezone: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          day_of_week: number
          enabled?: boolean
          id?: string
          last_sent_at?: string | null
          mode?: string
          require_approval?: boolean
          send_time: string
          target_chat_id: string
          target_name?: string | null
          timezone?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          day_of_week?: number
          enabled?: boolean
          id?: string
          last_sent_at?: string | null
          mode?: string
          require_approval?: boolean
          send_time?: string
          target_chat_id?: string
          target_name?: string | null
          timezone?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      strategy_memos: {
        Row: {
          created_at: string
          group_chat_id: string
          id: string
          memo: string
          recommendations: Json
          week_start: string
        }
        Insert: {
          created_at?: string
          group_chat_id: string
          id?: string
          memo: string
          recommendations?: Json
          week_start: string
        }
        Update: {
          created_at?: string
          group_chat_id?: string
          id?: string
          memo?: string
          recommendations?: Json
          week_start?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_bot_jobs: {
        Args: { p_chat?: string; p_limit?: number; p_worker: string }
        Returns: {
          attempts: number
          chat_id: string
          conversation_id: string | null
          created_at: string
          id: string
          kind: string
          last_error: string | null
          locked_by: string | null
          locked_until: string | null
          max_attempts: number
          payload: Json
          run_after: string
          status: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "bot_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      distinct_outbound_chats_last_hour: { Args: never; Returns: number }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "user"],
    },
  },
} as const
