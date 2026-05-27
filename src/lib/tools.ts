export const TOOLS = [
  {
    name: 'query_hysa',
    description:
      'Query the Bancadia registry for High-Yield Savings Account (HYSA) products using compound filter criteria. Returns active, verified listings from financial institutions.',
    inputSchema: {
      type: 'object',
      properties: {
        apy_min: {
          type: 'number',
          description: 'Minimum APY (inclusive)',
        },
        insurance_type: {
          type: 'string',
          enum: ['fdic', 'ncua'],
          description: 'Deposit insurance type',
        },
        available_states: {
          type: 'array',
          items: { type: 'string' },
          description: 'Returns listings available in all specified states',
        },
        minimum_opening_deposit_max: {
          type: 'number',
          description: 'Maximum minimum opening deposit',
        },
        monthly_fee_max: {
          type: 'number',
          description: 'Maximum monthly fee',
        },
        apy_rate_variability: {
          type: 'string',
          enum: ['fixed', 'variable'],
          description: 'Whether the APY is fixed or variable',
        },
        institution_type: {
          type: 'string',
          description: 'Filter by institution type (e.g. bank, credit_union, neobank)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'query_business_checking',
    description:
      'Query the Bancadia registry for business checking account products using compound filter criteria. Returns active, verified listings from financial institutions.',
    inputSchema: {
      type: 'object',
      properties: {
        monthly_fee_max: {
          type: 'number',
          description: 'Maximum monthly fee',
        },
        entity_types_accepted: {
          type: 'array',
          items: { type: 'string' },
          description: 'Returns listings accepting all specified entity types (e.g. llc, sole_proprietor)',
        },
        integrations: {
          type: 'array',
          items: { type: 'string' },
          description: 'Returns listings supporting all specified integrations (e.g. quickbooks, stripe)',
        },
        minimum_opening_deposit_max: {
          type: 'number',
          description: 'Maximum minimum opening deposit',
        },
        cash_deposit_available: {
          type: 'boolean',
          description: 'Whether cash deposits are supported',
        },
        sub_accounts_supported: {
          type: 'boolean',
          description: 'Whether sub-accounts are supported',
        },
        rtp_enabled: {
          type: 'boolean',
          description: 'Whether Real-Time Payments (RTP) are enabled',
        },
        free_transactions_min: {
          type: 'number',
          description: 'Minimum free transactions per month',
        },
      },
      additionalProperties: false,
    },
  },
]

export function getToolManifest() {
  return { tools: TOOLS }
}
