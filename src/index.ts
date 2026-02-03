import { createClient } from '@clickhouse/client'
import { evmDecoder, evmPortalSource } from '@subsquid/pipes/evm'
import { clickhouseTarget } from '@subsquid/pipes/targets/clickhouse'
import { events } from './abi/aave-v3-pool.js'
import path from 'node:path'

const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'

// Aave V3 deployed at block 16291127 on Ethereum mainnet
const AAVE_V3_DEPLOYMENT_BLOCK = '16291127'

// Focus on USDC for initial testing (can be expanded to all reserves)
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

async function main() {
  const client = createClient({
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || 'password',
    url: `http://${process.env.CLICKHOUSE_HOST || 'localhost'}:${process.env.CLICKHOUSE_PORT || '8123'}`,
    database: process.env.CLICKHOUSE_DATABASE || 'pipes',
  })

  await evmPortalSource({
    portal: 'https://portal.sqd.dev/datasets/ethereum-mainnet',
  })
    .pipe(
      evmDecoder({
        profiler: { id: 'aave-v3-usdc' },
        range: { from: AAVE_V3_DEPLOYMENT_BLOCK },
        contracts: [AAVE_V3_POOL],
        events: {
          supplies: events.Supply,
          withdraws: events.Withdraw,
          borrows: events.Borrow,
          repays: events.Repay,
        },
      }),
    )
  .pipe(({ supplies, withdraws, borrows, repays }) => {
    // Transform Supply events
    const supplyEvents = supplies
      .filter((e) => e.event.reserve.toLowerCase() === USDC.toLowerCase())
      .map((e) => ({
        block_number: e.block.number,
        tx_hash: e.rawEvent.transactionHash,
        log_index: e.rawEvent.logIndex,
        timestamp: Math.floor(e.timestamp.getTime() / 1000),
        event_type: 'supply',
        reserve: e.event.reserve.toLowerCase(),
        user: e.event.user.toLowerCase(),
        amount: e.event.amount.toString(),
        on_behalf_of: e.event.onBehalfOf.toLowerCase(),
        to: null,
        interest_rate_mode: null,
        borrow_rate: null,
        repayer: null,
        use_a_tokens: null,
        referral_code: e.event.referralCode,
        sign: 1,
      }))

    // Transform Withdraw events
    const withdrawEvents = withdraws
      .filter((e) => e.event.reserve.toLowerCase() === USDC.toLowerCase())
      .map((e) => ({
        block_number: e.block.number,
        tx_hash: e.rawEvent.transactionHash,
        log_index: e.rawEvent.logIndex,
        timestamp: Math.floor(e.timestamp.getTime() / 1000),
        event_type: 'withdraw',
        reserve: e.event.reserve.toLowerCase(),
        user: e.event.user.toLowerCase(),
        amount: e.event.amount.toString(),
        on_behalf_of: null,
        to: e.event.to.toLowerCase(),
        interest_rate_mode: null,
        borrow_rate: null,
        repayer: null,
        use_a_tokens: null,
        referral_code: null,
        sign: 1,
      }))

    // Transform Borrow events
    const borrowEvents = borrows
      .filter((e) => e.event.reserve.toLowerCase() === USDC.toLowerCase())
      .map((e) => ({
        block_number: e.block.number,
        tx_hash: e.rawEvent.transactionHash,
        log_index: e.rawEvent.logIndex,
        timestamp: Math.floor(e.timestamp.getTime() / 1000),
        event_type: 'borrow',
        reserve: e.event.reserve.toLowerCase(),
        user: e.event.user.toLowerCase(),
        amount: e.event.amount.toString(),
        on_behalf_of: e.event.onBehalfOf.toLowerCase(),
        to: null,
        interest_rate_mode: e.event.interestRateMode,
        borrow_rate: e.event.borrowRate.toString(),
        repayer: null,
        use_a_tokens: null,
        referral_code: e.event.referralCode,
        sign: 1,
      }))

    // Transform Repay events
    const repayEvents = repays
      .filter((e) => e.event.reserve.toLowerCase() === USDC.toLowerCase())
      .map((e) => ({
        block_number: e.block.number,
        tx_hash: e.rawEvent.transactionHash,
        log_index: e.rawEvent.logIndex,
        timestamp: Math.floor(e.timestamp.getTime() / 1000),
        event_type: 'repay',
        reserve: e.event.reserve.toLowerCase(),
        user: e.event.user.toLowerCase(),
        amount: e.event.amount.toString(),
        on_behalf_of: null,
        to: null,
        interest_rate_mode: null,
        borrow_rate: null,
        repayer: e.event.repayer.toLowerCase(),
        use_a_tokens: e.event.useATokens,
        referral_code: null,
        sign: 1,
      }))

    const allEvents = [
      ...supplyEvents,
      ...withdrawEvents,
      ...borrowEvents,
      ...repayEvents,
    ]

    // Calculate daily metrics
    const dailyMetrics = new Map()

    for (const e of allEvents) {
      const timestamp = new Date(e.timestamp * 1000)
      const dateKey = `${timestamp.toISOString().split('T')[0]}_${e.reserve}`

      if (!dailyMetrics.has(dateKey)) {
        dailyMetrics.set(dateKey, {
          date: timestamp.toISOString().split('T')[0],
          reserve: e.reserve,
          total_deposits: 0,
          deposit_count: 0,
          total_withdrawals: 0,
          withdrawal_count: 0,
        })
      }

      const metrics = dailyMetrics.get(dateKey)
      const amount = Number(e.amount) / 1e6 // USDC has 6 decimals

      if (e.event_type === 'supply' || e.event_type === 'repay') {
        metrics.total_deposits += amount
        metrics.deposit_count++
      }

      if (e.event_type === 'withdraw' || e.event_type === 'borrow') {
        metrics.total_withdrawals += amount
        metrics.withdrawal_count++
      }
    }

    const dailyMetricsRows = Array.from(dailyMetrics.values()).map((m) => ({
      ...m,
      net_flow: m.total_deposits - m.total_withdrawals,
      sign: 1,
    }))

    return {
      aave_events: allEvents,
      aave_daily_metrics: dailyMetricsRows,
    }
  })
    .pipeTo(
      clickhouseTarget({
        client,
        onStart: async ({ store }) => {
          const migrationsDir = path.join(process.cwd(), 'migrations')
          await store.executeFiles(migrationsDir)
        },
        onData: async ({ data, store }) => {
          if (data.aave_events.length > 0) {
            await store.insert({
              table: 'aave_events',
              values: data.aave_events,
              format: 'JSONEachRow',
            })
          }

          if (data.aave_daily_metrics.length > 0) {
            await store.insert({
              table: 'aave_daily_metrics',
              values: data.aave_daily_metrics,
              format: 'JSONEachRow',
            })
          }
        },
      }),
    )
}

void main()
