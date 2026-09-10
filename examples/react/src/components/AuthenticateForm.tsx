import { useQueryClient } from '@tanstack/react-query'
import {
  AccountTradingMode,
  API_KEY_INDEXES,
  selectAccountExistence,
  selectUserAccountIndex,
  useAccountsQuery,
  useLighterStore,
  useUserAccount,
  useUserAddress,
} from 'lighter-ts'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useChangeAccountConfigMutation } from '../hooks/useChangeAccountConfigMutation'
import { useChangePubKeyMutation } from '../hooks/useChangePubKeyMutation'
import { useCreateAccountMutation } from '../hooks/useCreateAccountMutation'
import { useSetIsRegistered } from '../hooks/useSetIsRegistered'
import { useSignMessagesMutation } from '../hooks/useSignMessagesMutation'
import { writeLSAccountSignature, writeLSLastAccountIndex } from '../utils/auth-storage'
import { useLogOut } from '../hooks/useLogOut'

const ERROR_FAIL_L1_SIGNATURE = 'fail to l1 signature'
const ERROR_INVALID_SIGNATURE = 'invalid signature'

const IS_MAINNET = true

const shortAddress = (address: string) =>
  address ? `${address.slice(0, 6)}…${address.slice(-4)}` : ''

type StepState = 'idle' | 'pending' | 'success' | 'error'

const STEP_LABEL: Record<StepState, string> = {
  idle: '',
  pending: '…',
  success: 'done',
  error: 'failed',
}

const Step = ({
  index,
  title,
  state,
  pendingLabel,
}: {
  index: number
  title: string
  state: StepState
  pendingLabel: string
}) => (
  <li className="auth-step" data-state={state}>
    <span className="auth-step-index">{state === 'success' ? '✓' : index}</span>
    <span className="auth-step-title">{title}</span>
    <span className="auth-step-state">
      {state === 'pending' && <span className="spinner" aria-hidden="true" />}
      {state === 'pending' ? pendingLabel : STEP_LABEL[state]}
    </span>
  </li>
)

const AuthenticateForm = () => {
  const accountExistence = useLighterStore(selectAccountExistence)

  const [shouldRemember, setShouldRemember] = useState(true)

  const queryClient = useQueryClient()
  const accountsQuery = useAccountsQuery()
  const userAccount = useUserAccount()
  const accountIndex = useLighterStore(selectUserAccountIndex)
  const userAddress = useUserAddress()
  const isEmbeddedWallet = false

  const cancelledChangePubKeyRef = useRef(false)
  const cancelledSignMessagesRef = useRef(false)
  const changeAccountConfigMutation = useChangeAccountConfigMutation()
  const setIsRegistered = useSetIsRegistered()
  const logout = useLogOut()

  const changePubKeyMutation = useChangePubKeyMutation({
    onMutate: () => {
      cancelledChangePubKeyRef.current = false
    },
    onError: (_error, { accountIndex }) => {
      setIsRegistered(accountIndex, false)
    },
    onSuccess: (_, { nonce, accountIndex, pk, seed }) => {
      setIsRegistered(accountIndex, true)
      writeLSLastAccountIndex(accountIndex)

      if (shouldRemember) {
        writeLSAccountSignature(accountIndex, API_KEY_INDEXES.DESKTOP, {
          pk,
          seed,
        })
      }

      if (
        nonce === 0 &&
        useLighterStore.getState().accountTradingMode === AccountTradingMode.CLASSIC
      ) {
        changeAccountConfigMutation.mutate({
          accountTradingMode: AccountTradingMode.UNIFIED,
        })
      }
    },
  })

  const signMessagesMutation = useSignMessagesMutation({
    onMutate: () => {
      cancelledSignMessagesRef.current = false
    },
    onSuccess: ({ body, pk, nonce, seed, useL1 }, { accountIndex }) =>
      changePubKeyMutation.mutate({
        accountIndex,
        shouldRefreshKey: false,
        nonce,
        message: body,
        pk,
        seed,
        apiKeyIndex: API_KEY_INDEXES.DESKTOP,
        useL1,
        cancelRef: cancelledChangePubKeyRef,
      }),
    onError: (error) => {
      console.error(error)
    },
  })

  const createAccountMutation = useCreateAccountMutation({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['account'] }),
  })

  const isAuthenticating = signMessagesMutation.isPending || changePubKeyMutation.isPending
  const didAuthenticate = changePubKeyMutation.isSuccess

  const handleCancel = () => {
    createAccountMutation.reset()
    signMessagesMutation.reset()
    changePubKeyMutation.reset()
    cancelledSignMessagesRef.current = true
    cancelledChangePubKeyRef.current = true
  }

  const changePubKeyErrorMessage = changePubKeyMutation.error?.message || ''
  const needETHSignature =
    changePubKeyErrorMessage.includes(ERROR_FAIL_L1_SIGNATURE) ||
    changePubKeyErrorMessage.includes(ERROR_INVALID_SIGNATURE)

  const isError =
    signMessagesMutation.isError || changePubKeyMutation.isError || createAccountMutation.isError

  const startSignMessages = useCallback(() => {
    signMessagesMutation.mutate({
      accountIndex,
      apiKeyIndex: API_KEY_INDEXES.DESKTOP,
      useL1: needETHSignature,
      cancelRef: cancelledSignMessagesRef,
      isEmbeddedWallet,
    })
  }, [isEmbeddedWallet, signMessagesMutation, accountIndex, needETHSignature])

  const buttonText = useMemo(() => {
    if (needETHSignature) {
      return 'Authenticate using L1'
    }

    if (isError) {
      return 'Try again'
    }

    return 'Sign to continue'
  }, [isError, needETHSignature])

  const showStagingCreate =
    !IS_MAINNET &&
    (createAccountMutation.isPending ||
      createAccountMutation.isSuccess ||
      (!accountsQuery.isPending && !userAccount))

  let createState: StepState = 'idle'
  if (createAccountMutation.isPending) {
    createState = 'pending'
  } else if (userAccount) {
    createState = 'success'
  } else if (createAccountMutation.isError) {
    createState = 'error'
  }
  const stepOffset = showStagingCreate ? 1 : 0

  let statusMessage = ''
  if (signMessagesMutation.isPending) {
    statusMessage = 'Waiting for signature'
  } else if (changePubKeyMutation.isPending) {
    statusMessage = 'Waiting for signature'
  } else if (didAuthenticate) {
    statusMessage = 'Authenticated'
  } else if (isError) {
    statusMessage = 'Try again'
  }

  let authButtonText = buttonText
  if (didAuthenticate) {
    authButtonText = 'Authenticated'
  } else if (statusMessage && isAuthenticating) {
    authButtonText = statusMessage
  }

  if (accountExistence === 'NoWallet' || !userAddress) {
    return null
  }

  if (accountExistence === 'Exists') {
    return (
      <section className="card auth-done">
        <span className="auth-done-icon" aria-hidden="true">
          ✓
        </span>
        <div>
          <h2 className="card-title">Authenticated</h2>
          <p>
            Trading key registered for <span className="mono">{shortAddress(userAddress)}</span>
          </p>
        </div>
      </section>
    )
  }

  if (accountExistence === 'Deciding') {
    return (
      <section className="card auth-loading">
        <span className="spinner" aria-hidden="true" />
        <span>Checking account…</span>
      </section>
    )
  }

  return (
    <section className="card">
      <header className="card-header">
        <h2 className="card-title">{userAccount ? 'Authenticate' : 'Create account'}</h2>
        <span className="address" title={userAddress}>
          {shortAddress(userAddress)}
        </span>
      </header>

      <ol className="auth-steps">
        {showStagingCreate && (
          <Step index={1} title="Create account" pendingLabel="creating" state={createState} />
        )}
        <Step
          index={1 + stepOffset}
          title={'Sign and register trading key'}
          pendingLabel={'signing'}
          state={
            changePubKeyMutation.status === 'idle'
              ? signMessagesMutation.status
              : changePubKeyMutation.status
          }
        />
      </ol>

      <fieldset className="auth-options" disabled={isAuthenticating || didAuthenticate}>
        <label>
          <input
            type="checkbox"
            checked={shouldRemember}
            onChange={(event) => setShouldRemember(event.target.checked)}
          />
          Remember me
        </label>
      </fieldset>

      {needETHSignature && (
        <p className="auth-note auth-note-error">
          That signature was rejected. Hardware wallets need to authenticate using L1.
        </p>
      )}

      <div className="auth-actions">
        <span className="auth-status" role="status" aria-live="polite">
          {isAuthenticating && <span className="spinner" aria-hidden="true" />}
          {statusMessage}
        </span>

        {isError && (
          <button type="button" className="btn btn-ghost" onClick={() => logout()}>
            Disconnect
          </button>
        )}

        {!userAccount && !IS_MAINNET ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={accountsQuery.isPending || createAccountMutation.isPending}
            onClick={() => createAccountMutation.mutate()}
          >
            {createAccountMutation.isPending ? 'Creating…' : buttonText}
          </button>
        ) : isAuthenticating ? (
          <button type="button" className="btn btn-ghost" onClick={handleCancel}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={didAuthenticate}
            onClick={startSignMessages}
          >
            {didAuthenticate ? `✓ ${authButtonText}` : authButtonText}
          </button>
        )}
      </div>
    </section>
  )
}

export default AuthenticateForm
