import type { FastifyReply, FastifyRequest } from 'fastify'
import { NoActiveSubscriptionError, PlanNotFoundError } from '../../domain/errors'
import type { CreateCheckoutSessionUseCase } from '../../application/use-cases/CreateCheckoutSessionUseCase'
import type { CancelSubscriptionUseCase } from '../../application/use-cases/CancelSubscriptionUseCase'
import {
  ChangePlanUseCase,
  SubscriptionNotEligibleForPlanChangeError,
} from '../../application/use-cases/ChangePlanUseCase'
import { TopUpCreditsUseCase, InvalidTopUpAmountError } from '../../application/use-cases/TopUpCreditsUseCase'
import type { GetSubscriptionStatusUseCase } from '../../application/use-cases/GetSubscriptionStatusUseCase'
import type { GetCreditBalanceUseCase } from '../../application/use-cases/GetCreditBalanceUseCase'
import type { ListPlansUseCase } from '../../application/use-cases/ListPlansUseCase'

export interface BillingRoutesUrls {
  /** Bases del callback en el backend (checkoutReturnRoutes), cada una con su ?flow= fijo. */
  checkoutReturnUrl: string
  creditsReturnUrl: string
  defaultCurrency: string
}

function withResult(returnUrlBase: string, result: 'success' | 'cancel'): string {
  const url = new URL(returnUrlBase)
  url.searchParams.set('result', result)
  return url.toString()
}

export interface CheckoutReturnQuery {
  result?: string
  flow?: string
}

export interface PlanIdBody {
  planId: string
}

export interface TopUpCreditsBody {
  amountInCents: number
  currency?: string
}

export class BillingController {
  constructor(
    private readonly createCheckoutSessionUseCase: CreateCheckoutSessionUseCase,
    private readonly cancelSubscriptionUseCase: CancelSubscriptionUseCase,
    private readonly changePlanUseCase: ChangePlanUseCase,
    private readonly topUpCreditsUseCase: TopUpCreditsUseCase,
    private readonly getSubscriptionStatusUseCase: GetSubscriptionStatusUseCase,
    private readonly getCreditBalanceUseCase: GetCreditBalanceUseCase,
    private readonly listPlansUseCase: ListPlansUseCase,
    private readonly urls: BillingRoutesUrls,
    private readonly frontendUrl: string,
  ) {}

  /**
   * Puente de retorno del checkout alojado de Recurrente: el navegador aterriza aquí
   * (mismo dominio del backend) antes de saltar al frontend, para que la cookie de
   * refresh token (sameSite: strict) no se pierda en la navegación cross-site que
   * viene de app.recurrente.com. No consulta el pago — la confirmación real llega
   * aparte por webhook; esto solo reenvía el resultado a la página correcta del frontend.
   */
  async checkoutReturn(req: FastifyRequest<{ Querystring: CheckoutReturnQuery }>, reply: FastifyReply) {
    const outcome = req.query.result === 'success' ? 'success' : 'cancel'
    const section = req.query.flow === 'credits' ? 'credits' : 'billing'

    return reply.redirect(`${this.frontendUrl}/${section}/${outcome}`)
  }

  async listPlans(_req: FastifyRequest, reply: FastifyReply) {
    const plans = await this.listPlansUseCase.execute()
    return reply.status(200).send({ plans })
  }

  async getSubscription(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }

    const result = await this.getSubscriptionStatusUseCase.execute(req.organizationId)
    return reply.status(200).send({ subscription: result })
  }

  async getCreditBalance(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }

    const result = await this.getCreditBalanceUseCase.execute(req.organizationId)
    return reply.status(200).send(result)
  }

  async checkout(req: FastifyRequest<{ Body: PlanIdBody }>, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }

    try {
      const result = await this.createCheckoutSessionUseCase.execute({
        organizationId: req.organizationId,
        planId: req.body.planId,
        returnUrlBase: this.urls.checkoutReturnUrl,
      })
      return reply.status(200).send({ checkoutUrl: result.checkoutUrl })
    } catch (error) {
      if (error instanceof PlanNotFoundError) {
        return reply.status(400).send({ error: 'PLAN_NOT_FOUND' })
      }
      throw error
    }
  }

  async cancel(req: FastifyRequest, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }

    try {
      const result = await this.cancelSubscriptionUseCase.execute({ organizationId: req.organizationId })
      return reply.status(200).send(result)
    } catch (error) {
      if (error instanceof NoActiveSubscriptionError) {
        return reply.status(404).send({ error: 'NO_ACTIVE_SUBSCRIPTION' })
      }
      throw error
    }
  }

  async changePlan(req: FastifyRequest<{ Body: PlanIdBody }>, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }

    try {
      const result = await this.changePlanUseCase.execute({
        organizationId: req.organizationId,
        newPlanId: req.body.planId,
      })
      return reply.status(200).send(result)
    } catch (error) {
      if (error instanceof NoActiveSubscriptionError) {
        return reply.status(404).send({ error: 'NO_ACTIVE_SUBSCRIPTION' })
      }
      if (error instanceof PlanNotFoundError) {
        return reply.status(400).send({ error: 'PLAN_NOT_FOUND' })
      }
      if (error instanceof SubscriptionNotEligibleForPlanChangeError) {
        return reply.status(409).send({ error: 'SUBSCRIPTION_NOT_ELIGIBLE' })
      }
      throw error
    }
  }

  async topUpCredits(req: FastifyRequest<{ Body: TopUpCreditsBody }>, reply: FastifyReply) {
    if (!req.organizationId) {
      return reply.status(400).send({ error: 'MISSING_ORGANIZATION' })
    }

    try {
      const result = await this.topUpCreditsUseCase.execute({
        organizationId: req.organizationId,
        amountInCents: req.body.amountInCents,
        currency: req.body.currency ?? this.urls.defaultCurrency,
        successUrl: withResult(this.urls.creditsReturnUrl, 'success'),
        cancelUrl: withResult(this.urls.creditsReturnUrl, 'cancel'),
      })
      return reply.status(200).send({ checkoutUrl: result.checkoutUrl })
    } catch (error) {
      if (error instanceof InvalidTopUpAmountError) {
        return reply.status(400).send({ error: 'INVALID_TOPUP_AMOUNT' })
      }
      throw error
    }
  }
}
