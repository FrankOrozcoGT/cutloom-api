export interface SubtitleCorrectionProps {
  start: number
  end: number
  original: string
  corrected: string
}

/** Preserva start/end del segmento original; solo el texto puede cambiar. */
export class SubtitleCorrection {
  private constructor(private readonly props: SubtitleCorrectionProps) {}

  static create(props: SubtitleCorrectionProps): SubtitleCorrection {
    return new SubtitleCorrection(props)
  }

  get start(): number {
    return this.props.start
  }

  get end(): number {
    return this.props.end
  }

  get original(): string {
    return this.props.original
  }

  get corrected(): string {
    return this.props.corrected
  }

  toJSON() {
    return { ...this.props }
  }
}
