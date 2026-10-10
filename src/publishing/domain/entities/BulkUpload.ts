export const BulkUploadStatus = {
  /** El usuario sigue subiendo (o puede resumir) algún SourceUpload de este bulk — cualquier
   * actividad en cualquier archivo reinicia lastActivityAt para todo el bulk, no solo ese item. */
  Active: 'active',
  /** Todos los SourceUpload del bulk terminaron de subir — publishAt ya se calculó. Los binarios
   * ya están a salvo en R2; recién desde acá puede empezar el intento de publicación. */
  Uploaded: 'uploaded',
  /** Hay al menos un PublishedVideo de este bulk sin resolver de forma terminal exitosa — en
   * curso (Publishing/AwaitingUpload) o Failed, reintentable mientras exista alguna fecha de
   * publicación del bulk todavía vigente (ver BulkUploadReconciliationUseCase). */
  Publishing: 'publishing',
  /** Terminal: todos los PublishedVideo de este bulk llegaron a un estado exitoso terminal
   * (Uploaded/Inbox) — ninguno quedó Failed. */
  Completed: 'completed',
  /** Terminal: ya pasaron todas las fechas de publicación del bulk y al menos un PublishedVideo
   * sigue Failed — no hay ninguna ventana futura en la que reintentar tenga sentido por sí sola,
   * pero el usuario puede reintentar manualmente en cualquier momento (ver RetryFailedPublicationsUseCase). */
  CompletedWithFailures: 'completed_with_failures',
  /** 7 días sin actividad en ningún archivo del bulk mientras seguía Active — nunca llegó a
   * terminar de subir (ver ExpireStaleBulkUploadsUseCase), nunca una expiración parcial por archivo. */
  Expired: 'expired',
} as const
export type BulkUploadStatus = (typeof BulkUploadStatus)[keyof typeof BulkUploadStatus]

export interface BulkUploadProps {
  id: string
  organizationId: string
  seriesId: string
  /** Huso horario IANA del público objetivo — persistido acá porque ScheduleUploadPlanService recién se invoca cuando TODO el bulk terminó de subir, que puede ser mucho después de planBulkUpload. */
  timeZone: string
  longVideoPublishDay: Date
  status: BulkUploadStatus
  lastActivityAt: Date
  createdAt: Date
}

/**
 * La unidad real que el usuario arma de una vez: un video largo + sus shorts derivados, hacia
 * una o varias plataformas — agrupa todos los SourceUpload y PublishedVideo de un mismo
 * seriesId para poder expirar/cancelar el conjunto completo como un todo, nunca archivo por
 * archivo (ver BulkUploadStatus.Expired).
 */
export class BulkUpload {
  private constructor(private readonly props: BulkUploadProps) {}

  static create(props: BulkUploadProps): BulkUpload {
    return new BulkUpload(props)
  }

  get id(): string {
    return this.props.id
  }

  get organizationId(): string {
    return this.props.organizationId
  }

  get seriesId(): string {
    return this.props.seriesId
  }

  get timeZone(): string {
    return this.props.timeZone
  }

  get longVideoPublishDay(): Date {
    return this.props.longVideoPublishDay
  }

  get status(): BulkUploadStatus {
    return this.props.status
  }

  get lastActivityAt(): Date {
    return this.props.lastActivityAt
  }

  get createdAt(): Date {
    return this.props.createdAt
  }
}
