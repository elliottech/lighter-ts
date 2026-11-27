import { describe, expect, it } from 'vitest'

import { isInvalidSignatureRejection } from './authToken'

const response = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

describe('isInvalidSignatureRejection', () => {
  it.each([
    [401, { code: 20013, message: 'invalid auth: invalid signature' }],
    [400, { code: 29500, message: 'internal server error: invalid signature' }],
  ])('is a %i with its invalid signature code', async (status, body) => {
    await expect(isInvalidSignatureRejection(response(status, body))).resolves.toBe(true)
  })

  it.each([
    [401, { code: 20013, message: 'invalid auth: expired token' }],
    [401, { code: 29500, message: 'invalid signature' }],
    [400, { code: 20013, message: 'invalid auth: invalid signature' }],
    [400, { code: 21108, message: 'invalid PublicKey,please run changePubKey' }],
    [403, { code: 20013, message: 'invalid auth: invalid signature' }],
    [200, { code: 20013, message: 'invalid auth: invalid signature' }],
    [401, { code: 20013 }],
    [401, null],
    [401, []],
    [401, 'invalid signature'],
    [401, 'not json'],
  ])('is not a %i with %j', async (status, body) => {
    await expect(isInvalidSignatureRejection(response(status, body))).resolves.toBe(false)
  })

  it('leaves the body readable for the caller', async () => {
    const rejected = response(401, { code: 20013, message: 'invalid auth: invalid signature' })

    await isInvalidSignatureRejection(rejected)

    await expect(rejected.json()).resolves.toEqual({
      code: 20013,
      message: 'invalid auth: invalid signature',
    })
  })
})
