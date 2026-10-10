import type { Database } from '../../../shared/infrastructure/db/client'
import { readEnv } from '../../../shared/infrastructure/config/readEnv'
import { DrizzlePlanRepository } from '../repositories/DrizzlePlanRepository'
import { DrizzleSubscriptionRepository } from '../repositories/DrizzleSubscriptionRepository'
import { DrizzlePlanFeatureAccessRepository } from '../repositories/DrizzlePlanFeatureAccessRepository'
import { DrizzleCreditAccountRepository } from '../repositories/DrizzleCreditAccountRepository'
import { DrizzleFeatureRepository } from '../repositories/DrizzleFeatureRepository'
import { DrizzleDonationRepository } from '../repositories/DrizzleDonationRepository'
import { RecurrentePaymentGatewayProvider } from '../providers/RecurrentePaymentGatewayProvider'
import { CreateCheckoutSessionUseCase } from '../../application/use-cases/CreateCheckoutSessionUseCase'
import { ActivateSubscriptionUseCase } from '../../application/use-cases/ActivateSubscriptionUseCase'
import { RenewalUseCase } from '../../application/use-cases/RenewalUseCase'
import { PaymentFailureUseCase } from '../../application/use-cases/PaymentFailureUseCase'
import { CancelSubscriptionUseCase } from '../../application/use-cases/CancelSubscriptionUseCase'
import { ExpireCancelledSubscriptionsUseCase } from '../../application/use-cases/ExpireCancelledSubscriptionsUseCase'
import { ChangePlanUseCase } from '../../application/use-cases/ChangePlanUseCase'
import { GrantMonthlyPlanCreditsUseCase } from '../../application/use-cases/GrantMonthlyPlanCreditsUseCase'
import { TopUpCreditsUseCase } from '../../application/use-cases/TopUpCreditsUseCase'
import { CreateDonationUseCase } from '../../application/use-cases/CreateDonationUseCase'
import { RecordDonationUseCase } from '../../application/use-cases/RecordDonationUseCase'
import { GetSubscriptionStatusUseCase } from '../../application/use-cases/GetSubscriptionStatusUseCase'
import { GetCreditBalanceUseCase } from '../../application/use-cases/GetCreditBalanceUseCase'
import { AuthorizeFeatureUsageUseCase } from '../../application/use-cases/AuthorizeFeatureUsageUseCase'
import { ListPlansUseCase } from '../../application/use-cases/ListPlansUseCase'
import { BillingController } from '../http/BillingController'
import type { WebhookModule } from '../http/webhookRoutes'
import type { PlanFeatureAccessRepository } from '../../domain/ports/PlanFeatureAccessRepository'

export interface BillingModule {
  controller: BillingController
  webhookModule: WebhookModule
  createDonationUseCase: CreateDonationUseCase
  expireCancelledSubscriptionsUseCase: ExpireCancelledSubscriptionsUseCase
  grantMonthlyPlanCreditsUseCase: GrantMonthlyPlanCreditsUseCase
  donationRoutesConfig: { successUrl: string; cancelUrl: string; defaultCurrency: string }
  planFeatureAccessRepository: PlanFeatureAccessRepository
  /** Puerto de autorización reutilizable desde otros bounded contexts (ver Unidad de créditos/entitlements). */
  authorizeFeatureUsageUseCase: AuthorizeFeatureUsageUseCase
  getCreditBalanceUseCase: GetCreditBalanceUseCase
}

export function buildBillingModule(db: Database): BillingModule {
  const planRepository = new DrizzlePlanRepository(db)
  const subscriptionRepository = new DrizzleSubscriptionRepository(db)
  const planFeatureAccessRepository = new DrizzlePlanFeatureAccessRepository(db)
  const creditAccountRepository = new DrizzleCreditAccountRepository(db)
  const featureRepository = new DrizzleFeatureRepository(db)
  const donationRepository = new DrizzleDonationRepository(db)

  const frontendUrl = readEnv('FRONTEND_URL', 'http://localhost:5173')
  // URL pública por la que Recurrente puede alcanzar este backend (túnel en dev, dominio
  // real en producción) — usada para el puente checkout-return, no para el webhook.
  const apiBaseUrl = readEnv('API_BASE_URL', 'http://localhost:3000')

  const paymentGatewayProvider = new RecurrentePaymentGatewayProvider({
    apiKey: readEnv('RECURRENTE_API_KEY', process.env.NODE_ENV === 'production' ? undefined : 'sk_test_placeholder'),
    webhookSecret: readEnv(
      'PAYMENT_GATEWAY_WEBHOOK_SECRET',
      process.env.NODE_ENV === 'production' ? undefined : 'whsec_placeholder',
    ),
    baseUrl: readEnv('RECURRENTE_API_BASE_URL', 'https://app.recurrente.com/api'),
  })

  const createCheckoutSessionUseCase = new CreateCheckoutSessionUseCase(
    planRepository,
    subscriptionRepository,
    paymentGatewayProvider,
  )
  const activateSubscriptionUseCase = new ActivateSubscriptionUseCase(
    subscriptionRepository,
    creditAccountRepository,
    planRepository,
  )
  const renewalUseCase = new RenewalUseCase(subscriptionRepository, creditAccountRepository, planRepository)
  const paymentFailureUseCase = new PaymentFailureUseCase(subscriptionRepository)
  const cancelSubscriptionUseCase = new CancelSubscriptionUseCase(subscriptionRepository, paymentGatewayProvider)
  const expireCancelledSubscriptionsUseCase = new ExpireCancelledSubscriptionsUseCase(subscriptionRepository)
  const changePlanUseCase = new ChangePlanUseCase(
    subscriptionRepository,
    creditAccountRepository,
    planRepository,
    paymentGatewayProvider,
  )
  const topUpCreditsUseCase = new TopUpCreditsUseCase(
    creditAccountRepository,
    paymentGatewayProvider,
    Number(readEnv('CREDIT_TOPUP_RATE_CENTS_PER_UNIT', '200')),
  )
  const grantMonthlyPlanCreditsUseCase = new GrantMonthlyPlanCreditsUseCase(
    subscriptionRepository,
    creditAccountRepository,
    planRepository,
  )
  const createDonationUseCase = new CreateDonationUseCase(paymentGatewayProvider)
  const recordDonationUseCase = new RecordDonationUseCase(donationRepository)
  const getSubscriptionStatusUseCase = new GetSubscriptionStatusUseCase(subscriptionRepository)
  const getCreditBalanceUseCase = new GetCreditBalanceUseCase(creditAccountRepository)
  const authorizeFeatureUsageUseCase = new AuthorizeFeatureUsageUseCase(
    planFeatureAccessRepository,
    creditAccountRepository,
    featureRepository,
  )
  const listPlansUseCase = new ListPlansUseCase(planRepository)

  const controller = new BillingController(
    createCheckoutSessionUseCase,
    cancelSubscriptionUseCase,
    changePlanUseCase,
    topUpCreditsUseCase,
    getSubscriptionStatusUseCase,
    getCreditBalanceUseCase,
    listPlansUseCase,
    {
      checkoutReturnUrl: `${apiBaseUrl}/api/billing/checkout-return?flow=subscription`,
      creditsReturnUrl: `${apiBaseUrl}/api/billing/checkout-return?flow=credits`,
      defaultCurrency: readEnv('BILLING_DEFAULT_CURRENCY', 'GTQ'),
    },
    frontendUrl,
  )

  return {
    controller,
    webhookModule: {
      activateSubscriptionUseCase,
      renewalUseCase,
      paymentFailureUseCase,
      topUpCreditsUseCase,
      recordDonationUseCase,
      paymentGatewayProvider,
    },
    createDonationUseCase,
    expireCancelledSubscriptionsUseCase,
    grantMonthlyPlanCreditsUseCase,
    donationRoutesConfig: {
      successUrl: `${frontendUrl}/donate/success`,
      cancelUrl: `${frontendUrl}/donate/cancel`,
      defaultCurrency: readEnv('BILLING_DEFAULT_CURRENCY', 'GTQ'),
    },
    planFeatureAccessRepository,
    authorizeFeatureUsageUseCase,
    getCreditBalanceUseCase,
  }
}
