export class ApiError extends Error {
  constructor(
    public message: string,
    public code?: number,
  ) {
    super(message)
    Object.setPrototypeOf(this, ApiError.prototype)
  }
}
