export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      business_cd_details: {
        Row: {
          apy: number
          apy_rate_variability: Database["public"]["Enums"]["apy_rate_variability_enum"]
          apy_tiers: Json | null
          auto_renew: boolean
          compounding_frequency: Database["public"]["Enums"]["compounding_frequency_enum"]
          early_withdrawal_penalty_days: number | null
          listing_id: string
          maturity_date: string | null
          minimum_balance_to_earn_apy: number
          term_months: number
        }
        Insert: {
          apy: number
          apy_rate_variability?: Database["public"]["Enums"]["apy_rate_variability_enum"]
          apy_tiers?: Json | null
          auto_renew?: boolean
          compounding_frequency?: Database["public"]["Enums"]["compounding_frequency_enum"]
          early_withdrawal_penalty_days?: number | null
          listing_id: string
          maturity_date?: string | null
          minimum_balance_to_earn_apy?: number
          term_months: number
        }
        Update: {
          apy?: number
          apy_rate_variability?: Database["public"]["Enums"]["apy_rate_variability_enum"]
          apy_tiers?: Json | null
          auto_renew?: boolean
          compounding_frequency?: Database["public"]["Enums"]["compounding_frequency_enum"]
          early_withdrawal_penalty_days?: number | null
          listing_id?: string
          maturity_date?: string | null
          minimum_balance_to_earn_apy?: number
          term_months?: number
        }
        Relationships: [
          {
            foreignKeyName: "business_cd_details_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: true
            referencedRelation: "business_deposit_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      business_checking_details: {
        Row: {
          accounting_integration_available: boolean
          ach_debit_block_available: boolean
          apy: number | null
          apy_tiers: Json | null
          atm_fee_reimbursement: boolean
          atm_fee_reimbursement_limit: number | null
          atm_network: string | null
          bill_pay_available: boolean
          cash_deposit_available: boolean
          cash_deposit_fee_per_100: number | null
          check_writing_available: boolean
          corporate_card_available: boolean
          daily_debit_limit: number | null
          expense_integration_available: boolean
          free_domestic_wires_per_month: number | null
          free_transactions_per_month: number | null
          incoming_domestic_wire_fee: number
          incoming_international_wire_fee: number | null
          interest_bearing: boolean
          listing_id: string
          monthly_cash_deposit_limit: number | null
          multicurrency_support: boolean
          outgoing_domestic_wire_fee: number | null
          outgoing_international_wire_fee: number | null
          overdraft_line_of_credit_available: boolean
          overdraft_protection_available: boolean
          per_transaction_fee_after_limit: number | null
          physical_debit_card_available: boolean
          positive_pay_available: boolean
          remote_deposit_capture: boolean
          rtp_network: Database["public"]["Enums"]["rtp_network_enum"] | null
          rtp_supported: boolean
          sub_accounts_supported: boolean
          tax_integration_available: boolean
          virtual_cards_available: boolean
        }
        Insert: {
          accounting_integration_available?: boolean
          ach_debit_block_available?: boolean
          apy?: number | null
          apy_tiers?: Json | null
          atm_fee_reimbursement?: boolean
          atm_fee_reimbursement_limit?: number | null
          atm_network?: string | null
          bill_pay_available?: boolean
          cash_deposit_available?: boolean
          cash_deposit_fee_per_100?: number | null
          check_writing_available?: boolean
          corporate_card_available?: boolean
          daily_debit_limit?: number | null
          expense_integration_available?: boolean
          free_domestic_wires_per_month?: number | null
          free_transactions_per_month?: number | null
          incoming_domestic_wire_fee?: number
          incoming_international_wire_fee?: number | null
          interest_bearing?: boolean
          listing_id: string
          monthly_cash_deposit_limit?: number | null
          multicurrency_support?: boolean
          outgoing_domestic_wire_fee?: number | null
          outgoing_international_wire_fee?: number | null
          overdraft_line_of_credit_available?: boolean
          overdraft_protection_available?: boolean
          per_transaction_fee_after_limit?: number | null
          physical_debit_card_available?: boolean
          positive_pay_available?: boolean
          remote_deposit_capture?: boolean
          rtp_network?: Database["public"]["Enums"]["rtp_network_enum"] | null
          rtp_supported?: boolean
          sub_accounts_supported?: boolean
          tax_integration_available?: boolean
          virtual_cards_available?: boolean
        }
        Update: {
          accounting_integration_available?: boolean
          ach_debit_block_available?: boolean
          apy?: number | null
          apy_tiers?: Json | null
          atm_fee_reimbursement?: boolean
          atm_fee_reimbursement_limit?: number | null
          atm_network?: string | null
          bill_pay_available?: boolean
          cash_deposit_available?: boolean
          cash_deposit_fee_per_100?: number | null
          check_writing_available?: boolean
          corporate_card_available?: boolean
          daily_debit_limit?: number | null
          expense_integration_available?: boolean
          free_domestic_wires_per_month?: number | null
          free_transactions_per_month?: number | null
          incoming_domestic_wire_fee?: number
          incoming_international_wire_fee?: number | null
          interest_bearing?: boolean
          listing_id?: string
          monthly_cash_deposit_limit?: number | null
          multicurrency_support?: boolean
          outgoing_domestic_wire_fee?: number | null
          outgoing_international_wire_fee?: number | null
          overdraft_line_of_credit_available?: boolean
          overdraft_protection_available?: boolean
          per_transaction_fee_after_limit?: number | null
          physical_debit_card_available?: boolean
          positive_pay_available?: boolean
          remote_deposit_capture?: boolean
          rtp_network?: Database["public"]["Enums"]["rtp_network_enum"] | null
          rtp_supported?: boolean
          sub_accounts_supported?: boolean
          tax_integration_available?: boolean
          virtual_cards_available?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "business_checking_details_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: true
            referencedRelation: "business_deposit_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      business_deposit_account_features: {
        Row: {
          category: Database["public"]["Enums"]["feature_category_enum"]
          created_at: string
          description: string
          id: string
          listing_id: string
          plan_tier_id: string | null
          sort_order: number | null
          value: number | null
        }
        Insert: {
          category: Database["public"]["Enums"]["feature_category_enum"]
          created_at?: string
          description: string
          id?: string
          listing_id: string
          plan_tier_id?: string | null
          sort_order?: number | null
          value?: number | null
        }
        Update: {
          category?: Database["public"]["Enums"]["feature_category_enum"]
          created_at?: string
          description?: string
          id?: string
          listing_id?: string
          plan_tier_id?: string | null
          sort_order?: number | null
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "business_deposit_account_features_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "business_deposit_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_deposit_account_features_plan_tier_id_fkey"
            columns: ["plan_tier_id"]
            isOneToOne: false
            referencedRelation: "business_deposit_plan_tiers"
            referencedColumns: ["id"]
          },
        ]
      }
      business_deposit_accounts: {
        Row: {
          affiliate_disclosure: string | null
          agent_matching_paused: boolean
          application_method:
            | Database["public"]["Enums"]["app_method_enum"]
            | null
          application_url: string
          available_states: string[]
          country: string
          created_at: string
          currency: string
          custom_fields: Json | null
          deposit_insurance_extended: boolean
          deposit_insurance_extended_limit: number | null
          deposit_insurance_limit: number
          effective_date: string | null
          entity_types_accepted: Database["public"]["Enums"]["entity_type_enum"][]
          expiry_date: string | null
          id: string
          institution_id: string
          insurance_type: Database["public"]["Enums"]["insurance_type_enum"]
          is_affiliate_tracked: boolean
          is_verified: boolean
          last_modified: string
          last_verified: string | null
          listing_slug: string
          listing_status: Database["public"]["Enums"]["listing_status_enum"]
          minimum_annual_revenue: number | null
          minimum_balance_to_waive_fee: number | null
          minimum_opening_deposit: number
          monthly_fee: number
          monthly_fee_waiver_condition: string | null
          multiple_accounts_allowed: boolean
          product_disclosure_overview_url: string | null
          product_name: string
          product_type: Database["public"]["Enums"]["deposit_product_type_enum"]
          scheduled_publish_at: string | null
          schema_version: string
          staleness_flag: boolean
          time_in_business_required_months: number | null
          tracker_url: string | null
          us_based_business_required: boolean
          verification_source: string | null
        }
        Insert: {
          affiliate_disclosure?: string | null
          agent_matching_paused?: boolean
          application_method?:
            | Database["public"]["Enums"]["app_method_enum"]
            | null
          application_url: string
          available_states?: string[]
          country?: string
          created_at?: string
          currency?: string
          custom_fields?: Json | null
          deposit_insurance_extended?: boolean
          deposit_insurance_extended_limit?: number | null
          deposit_insurance_limit?: number
          effective_date?: string | null
          entity_types_accepted: Database["public"]["Enums"]["entity_type_enum"][]
          expiry_date?: string | null
          id?: string
          institution_id: string
          insurance_type: Database["public"]["Enums"]["insurance_type_enum"]
          is_affiliate_tracked?: boolean
          is_verified?: boolean
          last_modified?: string
          last_verified?: string | null
          listing_slug: string
          listing_status?: Database["public"]["Enums"]["listing_status_enum"]
          minimum_annual_revenue?: number | null
          minimum_balance_to_waive_fee?: number | null
          minimum_opening_deposit?: number
          monthly_fee?: number
          monthly_fee_waiver_condition?: string | null
          multiple_accounts_allowed?: boolean
          product_disclosure_overview_url?: string | null
          product_name: string
          product_type: Database["public"]["Enums"]["deposit_product_type_enum"]
          scheduled_publish_at?: string | null
          schema_version?: string
          staleness_flag?: boolean
          time_in_business_required_months?: number | null
          tracker_url?: string | null
          us_based_business_required?: boolean
          verification_source?: string | null
        }
        Update: {
          affiliate_disclosure?: string | null
          agent_matching_paused?: boolean
          application_method?:
            | Database["public"]["Enums"]["app_method_enum"]
            | null
          application_url?: string
          available_states?: string[]
          country?: string
          created_at?: string
          currency?: string
          custom_fields?: Json | null
          deposit_insurance_extended?: boolean
          deposit_insurance_extended_limit?: number | null
          deposit_insurance_limit?: number
          effective_date?: string | null
          entity_types_accepted?: Database["public"]["Enums"]["entity_type_enum"][]
          expiry_date?: string | null
          id?: string
          institution_id?: string
          insurance_type?: Database["public"]["Enums"]["insurance_type_enum"]
          is_affiliate_tracked?: boolean
          is_verified?: boolean
          last_modified?: string
          last_verified?: string | null
          listing_slug?: string
          listing_status?: Database["public"]["Enums"]["listing_status_enum"]
          minimum_annual_revenue?: number | null
          minimum_balance_to_waive_fee?: number | null
          minimum_opening_deposit?: number
          monthly_fee?: number
          monthly_fee_waiver_condition?: string | null
          multiple_accounts_allowed?: boolean
          product_disclosure_overview_url?: string | null
          product_name?: string
          product_type?: Database["public"]["Enums"]["deposit_product_type_enum"]
          scheduled_publish_at?: string | null
          schema_version?: string
          staleness_flag?: boolean
          time_in_business_required_months?: number | null
          tracker_url?: string | null
          us_based_business_required?: boolean
          verification_source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "business_deposit_accounts_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      business_deposit_fees: {
        Row: {
          amount: number | null
          amount_description: string | null
          created_at: string
          description: string
          eligibility_criteria: string | null
          fee_type: Database["public"]["Enums"]["fee_type_enum"]
          id: string
          listing_id: string
          plan_tier_id: string | null
          tiers: Json | null
          waivable: boolean
          waiver_condition: string | null
        }
        Insert: {
          amount?: number | null
          amount_description?: string | null
          created_at?: string
          description: string
          eligibility_criteria?: string | null
          fee_type: Database["public"]["Enums"]["fee_type_enum"]
          id?: string
          listing_id: string
          plan_tier_id?: string | null
          tiers?: Json | null
          waivable?: boolean
          waiver_condition?: string | null
        }
        Update: {
          amount?: number | null
          amount_description?: string | null
          created_at?: string
          description?: string
          eligibility_criteria?: string | null
          fee_type?: Database["public"]["Enums"]["fee_type_enum"]
          id?: string
          listing_id?: string
          plan_tier_id?: string | null
          tiers?: Json | null
          waivable?: boolean
          waiver_condition?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "business_deposit_fees_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "business_deposit_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_deposit_fees_plan_tier_id_fkey"
            columns: ["plan_tier_id"]
            isOneToOne: false
            referencedRelation: "business_deposit_plan_tiers"
            referencedColumns: ["id"]
          },
        ]
      }
      business_deposit_plan_tiers: {
        Row: {
          apy: number | null
          apy_condition: string | null
          apy_max_balance_eligible: number | null
          created_at: string
          id: string
          is_default: boolean
          listing_id: string
          monthly_fee: number
          monthly_fee_waiver_condition: string | null
          plan_name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          apy?: number | null
          apy_condition?: string | null
          apy_max_balance_eligible?: number | null
          created_at?: string
          id?: string
          is_default?: boolean
          listing_id: string
          monthly_fee?: number
          monthly_fee_waiver_condition?: string | null
          plan_name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          apy?: number | null
          apy_condition?: string | null
          apy_max_balance_eligible?: number | null
          created_at?: string
          id?: string
          is_default?: boolean
          listing_id?: string
          monthly_fee?: number
          monthly_fee_waiver_condition?: string | null
          plan_name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_deposit_plan_tiers_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "business_deposit_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      business_deposit_promotions: {
        Row: {
          bonus_amount: number
          condition_description: string
          created_at: string
          expiry_date: string | null
          id: string
          listing_id: string
          minimum_deposit: number | null
          promo_url: string | null
        }
        Insert: {
          bonus_amount: number
          condition_description: string
          created_at?: string
          expiry_date?: string | null
          id?: string
          listing_id: string
          minimum_deposit?: number | null
          promo_url?: string | null
        }
        Update: {
          bonus_amount?: number
          condition_description?: string
          created_at?: string
          expiry_date?: string | null
          id?: string
          listing_id?: string
          minimum_deposit?: number | null
          promo_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "business_deposit_promotions_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "business_deposit_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      business_savings_details: {
        Row: {
          apy: number
          apy_balance_variation: Database["public"]["Enums"]["apy_balance_variation_enum"]
          apy_effective_date: string | null
          apy_rate_variability: Database["public"]["Enums"]["apy_rate_variability_enum"]
          apy_tiers: Json | null
          compounding_frequency: Database["public"]["Enums"]["compounding_frequency_enum"]
          daily_withdrawal_limit: number | null
          debit_card_available: boolean
          linked_checking_required: boolean
          listing_id: string
          maximum_balance_for_apy: number | null
          minimum_balance_to_earn_apy: number
          mobile_check_deposit: boolean
          monthly_withdrawal_limit: number | null
          outgoing_wire_available: boolean
          outgoing_wire_fee: number | null
          promotional_apy: number | null
          promotional_apy_duration_days: number | null
          promotional_apy_expiry_date: string | null
          promotional_minimum_deposit: number | null
        }
        Insert: {
          apy: number
          apy_balance_variation?: Database["public"]["Enums"]["apy_balance_variation_enum"]
          apy_effective_date?: string | null
          apy_rate_variability?: Database["public"]["Enums"]["apy_rate_variability_enum"]
          apy_tiers?: Json | null
          compounding_frequency?: Database["public"]["Enums"]["compounding_frequency_enum"]
          daily_withdrawal_limit?: number | null
          debit_card_available?: boolean
          linked_checking_required?: boolean
          listing_id: string
          maximum_balance_for_apy?: number | null
          minimum_balance_to_earn_apy?: number
          mobile_check_deposit?: boolean
          monthly_withdrawal_limit?: number | null
          outgoing_wire_available?: boolean
          outgoing_wire_fee?: number | null
          promotional_apy?: number | null
          promotional_apy_duration_days?: number | null
          promotional_apy_expiry_date?: string | null
          promotional_minimum_deposit?: number | null
        }
        Update: {
          apy?: number
          apy_balance_variation?: Database["public"]["Enums"]["apy_balance_variation_enum"]
          apy_effective_date?: string | null
          apy_rate_variability?: Database["public"]["Enums"]["apy_rate_variability_enum"]
          apy_tiers?: Json | null
          compounding_frequency?: Database["public"]["Enums"]["compounding_frequency_enum"]
          daily_withdrawal_limit?: number | null
          debit_card_available?: boolean
          linked_checking_required?: boolean
          listing_id?: string
          maximum_balance_for_apy?: number | null
          minimum_balance_to_earn_apy?: number
          mobile_check_deposit?: boolean
          monthly_withdrawal_limit?: number | null
          outgoing_wire_available?: boolean
          outgoing_wire_fee?: number | null
          promotional_apy?: number | null
          promotional_apy_duration_days?: number | null
          promotional_apy_expiry_date?: string | null
          promotional_minimum_deposit?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "business_savings_details_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: true
            referencedRelation: "business_deposit_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      developer_api_tokens: {
        Row: {
          created_at: string
          developer_id: string
          id: string
          revoked_at: string | null
          token_hash: string
          token_name: string
          token_prefix: string
        }
        Insert: {
          created_at?: string
          developer_id: string
          id?: string
          revoked_at?: string | null
          token_hash: string
          token_name: string
          token_prefix: string
        }
        Update: {
          created_at?: string
          developer_id?: string
          id?: string
          revoked_at?: string | null
          token_hash?: string
          token_name?: string
          token_prefix?: string
        }
        Relationships: [
          {
            foreignKeyName: "developer_api_tokens_developer_id_fkey"
            columns: ["developer_id"]
            isOneToOne: false
            referencedRelation: "developer_users"
            referencedColumns: ["id"]
          },
        ]
      }
      developer_users: {
        Row: {
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      go_clicks: {
        Row: {
          clicked_at: string
          destination_url: string | null
          id: string
          listing_id: string | null
          product_source: string | null
          referrer: string | null
          slug: string
          traffic_source: Database["public"]["Enums"]["traffic_source_enum"]
          user_agent: string | null
        }
        Insert: {
          clicked_at?: string
          destination_url?: string | null
          id?: string
          listing_id?: string | null
          product_source?: string | null
          referrer?: string | null
          slug: string
          traffic_source: Database["public"]["Enums"]["traffic_source_enum"]
          user_agent?: string | null
        }
        Update: {
          clicked_at?: string
          destination_url?: string | null
          id?: string
          listing_id?: string | null
          product_source?: string | null
          referrer?: string | null
          slug?: string
          traffic_source?: Database["public"]["Enums"]["traffic_source_enum"]
          user_agent?: string | null
        }
        Relationships: []
      }
      institution_subscriptions: {
        Row: {
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          institution_id: string
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          institution_id: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          institution_id?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "institution_subscriptions_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: true
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      institution_users: {
        Row: {
          created_at: string
          id: string
          institution_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          institution_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          institution_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "institution_users_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      institutions: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          institution_type: Database["public"]["Enums"]["institution_type_enum"]
          is_active: boolean
          logo_url: string | null
          name: string
          support_email: string | null
          updated_at: string
          website_url: string | null
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          institution_type: Database["public"]["Enums"]["institution_type_enum"]
          is_active?: boolean
          logo_url?: string | null
          name: string
          support_email?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          institution_type?: Database["public"]["Enums"]["institution_type_enum"]
          is_active?: boolean
          logo_url?: string | null
          name?: string
          support_email?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Relationships: []
      }
      listing_audits: {
        Row: {
          action: string
          actor_email: string
          actor_id: string
          after_values: Json | null
          before_values: Json | null
          created_at: string
          id: string
          institution_id: string
          listing_id: string
          product_type: string
        }
        Insert: {
          action: string
          actor_email: string
          actor_id: string
          after_values?: Json | null
          before_values?: Json | null
          created_at?: string
          id?: string
          institution_id: string
          listing_id: string
          product_type: string
        }
        Update: {
          action?: string
          actor_email?: string
          actor_id?: string
          after_values?: Json | null
          before_values?: Json | null
          created_at?: string
          id?: string
          institution_id?: string
          listing_id?: string
          product_type?: string
        }
        Relationships: []
      }
      personal_cd_details: {
        Row: {
          apy: number
          apy_rate_variability: Database["public"]["Enums"]["apy_rate_variability_enum"]
          auto_renew: boolean
          compounding_frequency: Database["public"]["Enums"]["compounding_frequency_enum"]
          early_withdrawal_penalty_days: number | null
          listing_id: string
          maturity_date: string | null
          minimum_balance_to_earn_apy: number
          term_months: number
        }
        Insert: {
          apy: number
          apy_rate_variability?: Database["public"]["Enums"]["apy_rate_variability_enum"]
          auto_renew?: boolean
          compounding_frequency?: Database["public"]["Enums"]["compounding_frequency_enum"]
          early_withdrawal_penalty_days?: number | null
          listing_id: string
          maturity_date?: string | null
          minimum_balance_to_earn_apy?: number
          term_months: number
        }
        Update: {
          apy?: number
          apy_rate_variability?: Database["public"]["Enums"]["apy_rate_variability_enum"]
          auto_renew?: boolean
          compounding_frequency?: Database["public"]["Enums"]["compounding_frequency_enum"]
          early_withdrawal_penalty_days?: number | null
          listing_id?: string
          maturity_date?: string | null
          minimum_balance_to_earn_apy?: number
          term_months?: number
        }
        Relationships: [
          {
            foreignKeyName: "personal_cd_details_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: true
            referencedRelation: "personal_deposit_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      personal_checking_details: {
        Row: {
          apy: number | null
          atm_fee_reimbursement: boolean
          atm_fee_reimbursement_limit: number | null
          bill_pay_available: boolean
          check_writing_available: boolean
          compounding_frequency:
            | Database["public"]["Enums"]["compounding_frequency_enum"]
            | null
          free_transactions_per_month: number | null
          interest_bearing: boolean
          listing_id: string
          minimum_balance_to_earn_apy: number | null
          overdraft_line_of_credit_available: boolean
          overdraft_protection_available: boolean
          per_transaction_fee_after_limit: number | null
          remote_deposit_capture: boolean
        }
        Insert: {
          apy?: number | null
          atm_fee_reimbursement?: boolean
          atm_fee_reimbursement_limit?: number | null
          bill_pay_available?: boolean
          check_writing_available?: boolean
          compounding_frequency?:
            | Database["public"]["Enums"]["compounding_frequency_enum"]
            | null
          free_transactions_per_month?: number | null
          interest_bearing?: boolean
          listing_id: string
          minimum_balance_to_earn_apy?: number | null
          overdraft_line_of_credit_available?: boolean
          overdraft_protection_available?: boolean
          per_transaction_fee_after_limit?: number | null
          remote_deposit_capture?: boolean
        }
        Update: {
          apy?: number | null
          atm_fee_reimbursement?: boolean
          atm_fee_reimbursement_limit?: number | null
          bill_pay_available?: boolean
          check_writing_available?: boolean
          compounding_frequency?:
            | Database["public"]["Enums"]["compounding_frequency_enum"]
            | null
          free_transactions_per_month?: number | null
          interest_bearing?: boolean
          listing_id?: string
          minimum_balance_to_earn_apy?: number | null
          overdraft_line_of_credit_available?: boolean
          overdraft_protection_available?: boolean
          per_transaction_fee_after_limit?: number | null
          remote_deposit_capture?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "personal_checking_details_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: true
            referencedRelation: "personal_deposit_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      personal_deposit_accounts: {
        Row: {
          affiliate_disclosure: string | null
          agent_matching_paused: boolean
          application_method:
            | Database["public"]["Enums"]["app_method_enum"]
            | null
          application_url: string
          available_states: string[]
          country: string
          created_at: string
          currency: string
          custom_fields: Json | null
          debit_card_available: boolean
          deposit_insurance_extended: boolean
          deposit_insurance_extended_limit: number | null
          deposit_insurance_limit: number
          effective_date: string | null
          expiry_date: string | null
          id: string
          institution_id: string
          institution_type: Database["public"]["Enums"]["institution_type_enum"]
          insurance_type: Database["public"]["Enums"]["insurance_type_enum"]
          is_affiliate_tracked: boolean
          is_verified: boolean
          joint_account_available: boolean
          last_modified: string
          last_verified: string | null
          listing_status: Database["public"]["Enums"]["listing_status_enum"]
          membership_eligibility: string | null
          membership_required: boolean
          minimum_opening_deposit: number
          mobile_check_deposit: boolean
          monthly_fee: number
          monthly_fee_waiver_condition: string | null
          multiple_accounts_allowed: boolean
          new_customer_only: boolean
          product_disclosure_overview_url: string | null
          product_name: string
          product_type: Database["public"]["Enums"]["deposit_product_type_enum"]
          relationship_rate: boolean
          relationship_rate_description: string | null
          scheduled_publish_at: string | null
          schema_version: string
          staleness_flag: boolean
          tracker_url: string | null
          verification_source: string | null
          welcome_bonus_amount: number | null
          welcome_bonus_condition: string | null
          welcome_bonus_expiry_date: string | null
        }
        Insert: {
          affiliate_disclosure?: string | null
          agent_matching_paused?: boolean
          application_method?:
            | Database["public"]["Enums"]["app_method_enum"]
            | null
          application_url: string
          available_states?: string[]
          country?: string
          created_at?: string
          currency?: string
          custom_fields?: Json | null
          debit_card_available?: boolean
          deposit_insurance_extended?: boolean
          deposit_insurance_extended_limit?: number | null
          deposit_insurance_limit?: number
          effective_date?: string | null
          expiry_date?: string | null
          id?: string
          institution_id: string
          institution_type: Database["public"]["Enums"]["institution_type_enum"]
          insurance_type: Database["public"]["Enums"]["insurance_type_enum"]
          is_affiliate_tracked?: boolean
          is_verified?: boolean
          joint_account_available?: boolean
          last_modified?: string
          last_verified?: string | null
          listing_status?: Database["public"]["Enums"]["listing_status_enum"]
          membership_eligibility?: string | null
          membership_required?: boolean
          minimum_opening_deposit?: number
          mobile_check_deposit?: boolean
          monthly_fee?: number
          monthly_fee_waiver_condition?: string | null
          multiple_accounts_allowed?: boolean
          new_customer_only?: boolean
          product_disclosure_overview_url?: string | null
          product_name: string
          product_type: Database["public"]["Enums"]["deposit_product_type_enum"]
          relationship_rate?: boolean
          relationship_rate_description?: string | null
          scheduled_publish_at?: string | null
          schema_version?: string
          staleness_flag?: boolean
          tracker_url?: string | null
          verification_source?: string | null
          welcome_bonus_amount?: number | null
          welcome_bonus_condition?: string | null
          welcome_bonus_expiry_date?: string | null
        }
        Update: {
          affiliate_disclosure?: string | null
          agent_matching_paused?: boolean
          application_method?:
            | Database["public"]["Enums"]["app_method_enum"]
            | null
          application_url?: string
          available_states?: string[]
          country?: string
          created_at?: string
          currency?: string
          custom_fields?: Json | null
          debit_card_available?: boolean
          deposit_insurance_extended?: boolean
          deposit_insurance_extended_limit?: number | null
          deposit_insurance_limit?: number
          effective_date?: string | null
          expiry_date?: string | null
          id?: string
          institution_id?: string
          institution_type?: Database["public"]["Enums"]["institution_type_enum"]
          insurance_type?: Database["public"]["Enums"]["insurance_type_enum"]
          is_affiliate_tracked?: boolean
          is_verified?: boolean
          joint_account_available?: boolean
          last_modified?: string
          last_verified?: string | null
          listing_status?: Database["public"]["Enums"]["listing_status_enum"]
          membership_eligibility?: string | null
          membership_required?: boolean
          minimum_opening_deposit?: number
          mobile_check_deposit?: boolean
          monthly_fee?: number
          monthly_fee_waiver_condition?: string | null
          multiple_accounts_allowed?: boolean
          new_customer_only?: boolean
          product_disclosure_overview_url?: string | null
          product_name?: string
          product_type?: Database["public"]["Enums"]["deposit_product_type_enum"]
          relationship_rate?: boolean
          relationship_rate_description?: string | null
          scheduled_publish_at?: string | null
          schema_version?: string
          staleness_flag?: boolean
          tracker_url?: string | null
          verification_source?: string | null
          welcome_bonus_amount?: number | null
          welcome_bonus_condition?: string | null
          welcome_bonus_expiry_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "personal_deposit_accounts_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      personal_deposit_fees: {
        Row: {
          amount: number | null
          amount_description: string | null
          created_at: string
          description: string
          eligibility_criteria: string | null
          fee_type: Database["public"]["Enums"]["fee_type_enum"]
          id: string
          listing_id: string
          waivable: boolean
          waiver_condition: string | null
        }
        Insert: {
          amount?: number | null
          amount_description?: string | null
          created_at?: string
          description: string
          eligibility_criteria?: string | null
          fee_type: Database["public"]["Enums"]["fee_type_enum"]
          id?: string
          listing_id: string
          waivable?: boolean
          waiver_condition?: string | null
        }
        Update: {
          amount?: number | null
          amount_description?: string | null
          created_at?: string
          description?: string
          eligibility_criteria?: string | null
          fee_type?: Database["public"]["Enums"]["fee_type_enum"]
          id?: string
          listing_id?: string
          waivable?: boolean
          waiver_condition?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "personal_deposit_fees_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "personal_deposit_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      personal_savings_details: {
        Row: {
          apy: number
          apy_balance_variation: Database["public"]["Enums"]["apy_balance_variation_enum"]
          apy_effective_date: string | null
          apy_rate_variability: Database["public"]["Enums"]["apy_rate_variability_enum"]
          apy_tiers: Json | null
          compounding_frequency: Database["public"]["Enums"]["compounding_frequency_enum"]
          daily_withdrawal_limit: number | null
          linked_checking_required: boolean
          listing_id: string
          maximum_balance_for_apy: number | null
          minimum_balance_to_earn_apy: number
          monthly_withdrawal_limit: number | null
          outgoing_wire_available: boolean
          outgoing_wire_fee: number | null
          promotional_apy: number | null
          promotional_apy_duration_days: number | null
          promotional_apy_expiry_date: string | null
          promotional_minimum_deposit: number | null
        }
        Insert: {
          apy: number
          apy_balance_variation?: Database["public"]["Enums"]["apy_balance_variation_enum"]
          apy_effective_date?: string | null
          apy_rate_variability?: Database["public"]["Enums"]["apy_rate_variability_enum"]
          apy_tiers?: Json | null
          compounding_frequency?: Database["public"]["Enums"]["compounding_frequency_enum"]
          daily_withdrawal_limit?: number | null
          linked_checking_required?: boolean
          listing_id: string
          maximum_balance_for_apy?: number | null
          minimum_balance_to_earn_apy?: number
          monthly_withdrawal_limit?: number | null
          outgoing_wire_available?: boolean
          outgoing_wire_fee?: number | null
          promotional_apy?: number | null
          promotional_apy_duration_days?: number | null
          promotional_apy_expiry_date?: string | null
          promotional_minimum_deposit?: number | null
        }
        Update: {
          apy?: number
          apy_balance_variation?: Database["public"]["Enums"]["apy_balance_variation_enum"]
          apy_effective_date?: string | null
          apy_rate_variability?: Database["public"]["Enums"]["apy_rate_variability_enum"]
          apy_tiers?: Json | null
          compounding_frequency?: Database["public"]["Enums"]["compounding_frequency_enum"]
          daily_withdrawal_limit?: number | null
          linked_checking_required?: boolean
          listing_id?: string
          maximum_balance_for_apy?: number | null
          minimum_balance_to_earn_apy?: number
          monthly_withdrawal_limit?: number | null
          outgoing_wire_available?: boolean
          outgoing_wire_fee?: number | null
          promotional_apy?: number | null
          promotional_apy_duration_days?: number | null
          promotional_apy_expiry_date?: string | null
          promotional_minimum_deposit?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "personal_savings_details_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: true
            referencedRelation: "personal_deposit_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      query_match_events: {
        Row: {
          developer_id: string | null
          id: string
          institution_id: string
          listing_id: string
          matched_at: string
          product_type: string
          query_filters: Json | null
        }
        Insert: {
          developer_id?: string | null
          id?: string
          institution_id: string
          listing_id: string
          matched_at?: string
          product_type: string
          query_filters?: Json | null
        }
        Update: {
          developer_id?: string | null
          id?: string
          institution_id?: string
          listing_id?: string
          matched_at?: string
          product_type?: string
          query_filters?: Json | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      app_method_enum: "online" | "branch" | "phone"
      apy_balance_variation_enum: "none" | "tiered" | "blended" | "stepped"
      apy_rate_variability_enum: "fixed" | "variable"
      compounding_frequency_enum: "daily" | "monthly" | "quarterly" | "annually"
      deposit_product_type_enum: "hysa" | "money_market" | "checking" | "cd"
      entity_type_enum:
        | "llc"
        | "s_corp"
        | "c_corp"
        | "sole_prop"
        | "partnership"
        | "nonprofit"
      feature_category_enum:
        | "payment_rails"
        | "cash_handling"
        | "cards_and_atm"
        | "online_banking"
        | "fraud_protection"
        | "account_management"
        | "platform_integrations"
        | "other"
      fee_type_enum:
        | "monthly_maintenance"
        | "overdraft"
        | "non_sufficient_funds"
        | "account_opening"
        | "account_closing"
        | "minimum_balance"
        | "excess_transaction"
        | "atm_foreign"
        | "wire_domestic_outgoing"
        | "wire_domestic_incoming"
        | "wire_international_outgoing"
        | "wire_international_incoming"
        | "cash_deposit"
        | "paper_statement"
        | "dormancy"
        | "returned_item"
        | "stop_payment"
        | "card_replacement"
        | "foreign_transaction"
        | "other"
      institution_type_enum:
        | "national_bank"
        | "regional_bank"
        | "community_bank"
        | "credit_union"
        | "neobank"
        | "fintech"
      insurance_type_enum: "fdic" | "ncua" | "uninsured"
      listing_status_enum: "draft" | "active" | "paused" | "scheduled"
      rtp_network_enum: "fednow" | "rtp_network" | "both" | "none"
      traffic_source_enum:
        | "organic"
        | "llm"
        | "direct"
        | "social"
        | "search"
        | "referral"
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_method_enum: ["online", "branch", "phone"],
      apy_balance_variation_enum: ["none", "tiered", "blended", "stepped"],
      apy_rate_variability_enum: ["fixed", "variable"],
      compounding_frequency_enum: ["daily", "monthly", "quarterly", "annually"],
      deposit_product_type_enum: ["hysa", "money_market", "checking", "cd"],
      entity_type_enum: [
        "llc",
        "s_corp",
        "c_corp",
        "sole_prop",
        "partnership",
        "nonprofit",
      ],
      feature_category_enum: [
        "payment_rails",
        "cash_handling",
        "cards_and_atm",
        "online_banking",
        "fraud_protection",
        "account_management",
        "platform_integrations",
        "other",
      ],
      fee_type_enum: [
        "monthly_maintenance",
        "overdraft",
        "non_sufficient_funds",
        "account_opening",
        "account_closing",
        "minimum_balance",
        "excess_transaction",
        "atm_foreign",
        "wire_domestic_outgoing",
        "wire_domestic_incoming",
        "wire_international_outgoing",
        "wire_international_incoming",
        "cash_deposit",
        "paper_statement",
        "dormancy",
        "returned_item",
        "stop_payment",
        "card_replacement",
        "foreign_transaction",
        "other",
      ],
      institution_type_enum: [
        "national_bank",
        "regional_bank",
        "community_bank",
        "credit_union",
        "neobank",
        "fintech",
      ],
      insurance_type_enum: ["fdic", "ncua", "uninsured"],
      listing_status_enum: ["draft", "active", "paused", "scheduled"],
      rtp_network_enum: ["fednow", "rtp_network", "both", "none"],
      traffic_source_enum: [
        "organic",
        "llm",
        "direct",
        "social",
        "search",
        "referral",
      ],
    },
  },
} as const

