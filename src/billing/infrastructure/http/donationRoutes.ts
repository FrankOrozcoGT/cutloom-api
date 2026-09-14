import type { FastifyInstance } from 'fastify'
import { InvalidDonationAmountError, type CreateDonationUseCase } from '../../application/use-cases/CreateDonationUseCase'

const donationBodySchema = {
  type: 'object',
  required: ['amountInCents'],
  properties: {
    amountInCents: { type: 'number' },
    currency: { type: 'string' },
  },
} as const

interface DonationBody {
  amountInCents: number
  currency?: string
}

export interface DonationRoutesConfig {
  successUrl: string
  cancelUrl: string
  defaultCurrency: string
}

/** Ruta pública, SIN authMiddleware: el opt-in de free tier/visitantes no requiere sesión. */
export function registerDonationRoutes(
  app: FastifyInstance,
  createDonationUseCase: CreateDonationUseCase,
  config: DonationRoutesConfig,
) {
  app.register(
    (donationApp, _opts, done) => {
      donationApp.post<{ Body: DonationBody }>('/coffee', { schema: { body: donationBodySchema } }, async (req, reply) => {
        const { amountInCents, currency } = req.body

        try {
          const result = await createDonationUseCase.execute({
            organizationId: null,
            amountInCents,
            currency: currency ?? config.defaultCurrency,
            successUrl: config.successUrl,
            cancelUrl: config.cancelUrl,
          })
          return reply.status(200).send({ donationUrl: result.donationUrl })
        } catch (error) {
          if (error instanceof InvalidDonationAmountError) {
            return reply.status(400).send({ error: 'INVALID_DONATION_AMOUNT' })
          }
          throw error
        }
      })

      done()
    },
    { prefix: '/api/billing/donations' },
  )
}
