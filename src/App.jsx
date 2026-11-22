import { useEffect, useRef, useState } from 'react'

const SIGNALING_URL = 'wss://inai-col3.fishrungames.com/signaling/'
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

export default function App() {
  const localVideoRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const streamRef = useRef(null)
  const socketRef = useRef(null)
  const peerRef = useRef(null)
  const pendingIceRef = useRef([])
  const cameraRequestRef = useRef(null)
  const callIdRef = useRef(null)
  const callTimerRef = useRef(null)
  const localIceRef = useRef([])

  const [status, setStatus] = useState('Включи камеру и подключись к серверу')
  const [cameraState, setCameraState] = useState('off')
  const [socketState, setSocketState] = useState('closed')
  const [callActive, setCallActive] = useState(false)

  useEffect(() => {
    return () => {
      cameraRequestRef.current = null
      clearTimeout(callTimerRef.current)
      const socket = socketRef.current
      socketRef.current = null
      socket?.close()
      peerRef.current?.close()
      peerRef.current = null
      pendingIceRef.current = []
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [])

  async function startCamera() {
    if (streamRef.current || cameraRequestRef.current) return

    const request = {}
    cameraRequestRef.current = request
    setCameraState('loading')

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Камера доступна только через HTTPS или localhost')
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      })

      if (cameraRequestRef.current !== request) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      streamRef.current = stream
      localVideoRef.current.srcObject = stream
      setCameraState('on')
      setStatus('Камера и микрофон включены')
    } catch (error) {
      if (cameraRequestRef.current === request) {
        setCameraState('off')
        const reason = error.name === 'NotAllowedError'
          ? 'Разреши доступ к камере и микрофону в браузере'
          : error.name === 'NotFoundError'
            ? 'Камера или микрофон не найдены'
            : error.message
        setStatus(`Не удалось включить камеру или микрофон. ${reason}`)
      }
    } finally {
      if (cameraRequestRef.current === request) {
        cameraRequestRef.current = null
      }
    }
  }

  function closeCall() {
    const peer = peerRef.current
    peerRef.current = null
    callIdRef.current = null
    clearTimeout(callTimerRef.current)
    callTimerRef.current = null
    localIceRef.current = []
    pendingIceRef.current = []
    setCallActive(false)
    peer?.close()

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }
  }

  function send(socket, message) {
    if (socketRef.current === socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message))
    }
  }

  function createPeer(socket, stream, callId) {
    const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    peerRef.current = peer
    callIdRef.current = callId
    setCallActive(true)

    // Если второго клиента нет, разрешаем повторить вызов, а не зависаем навсегда.
    callTimerRef.current = setTimeout(() => {
      if (peerRef.current !== peer) return
      send(socket, { type: 'hangup', callId })
      closeCall()
      setStatus('Собеседник не ответил. Проверь второе окно и позвони снова')
    }, 30000)

    for (const track of stream.getTracks()) {
      peer.addTrack(track, stream)
    }

    peer.onicecandidate = ({ candidate }) => {
      if (!candidate || peerRef.current !== peer) return

      const ice = candidate.toJSON()
      localIceRef.current.push(ice)
      send(socket, { type: 'ice', callId, candidate: ice })
    }

    peer.ontrack = ({ streams }) => {
      if (peerRef.current === peer && streams[0] && remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = streams[0]
      }
    }

    peer.onconnectionstatechange = () => {
      if (peerRef.current !== peer) return

      console.log('WebRTC:', peer.connectionState)

      if (peer.connectionState === 'connected') {
        clearTimeout(callTimerRef.current)
        setStatus('Звонок подключён')
      }

      if (peer.connectionState === 'disconnected') {
        setStatus('Видеосвязь прервалась. Ожидаем восстановления…')
      }

      if (peer.connectionState === 'failed') {
        send(socket, { type: 'hangup', callId })
        closeCall()
        setStatus('Не удалось установить видеосвязь. Попробуй позвонить снова')
      }
    }

    return peer
  }

  async function applyRemoteDescription(peer, description) {
    await peer.setRemoteDescription(description)
    if (peerRef.current !== peer) return

    // Применяем кандидатов, которые пришли раньше offer или answer.
    for (const message of pendingIceRef.current.splice(0)) {
      if (message.callId !== callIdRef.current) continue
      await peer.addIceCandidate(message.candidate)
      if (peerRef.current !== peer) return
    }
  }

  async function handleMessage(socket, data) {
    let message
    try {
      message = JSON.parse(data)
    } catch {
      return // Чужое некорректное сообщение не должно завершать текущий звонок.
    }
    if (!message || typeof message !== 'object') return

    if (message.type === 'peer-left') {
      closeCall()
      setStatus('Собеседник вышел')
      return
    }

    if (message.type === 'ready') {
      const peer = peerRef.current
      // Offer мог уйти, пока второго клиента ещё не было на сервере.
      if (peer?.signalingState === 'have-local-offer') {
        send(socket, { type: 'offer', callId: callIdRef.current, description: peer.localDescription })
        for (const candidate of localIceRef.current) {
          send(socket, { type: 'ice', callId: callIdRef.current, candidate })
        }
      }
      return
    }

    if (message.type === 'hangup' || message.type === 'not-ready') {
      if (message.callId !== callIdRef.current) return
      closeCall()
      setStatus(message.type === 'not-ready'
        ? 'Собеседник ещё не включил камеру. Позвони, когда он будет готов'
        : 'Собеседник завершил звонок. Можно позвонить снова')
      return
    }

    if (typeof message.callId !== 'string') return

    if (message.type === 'ice' && message.candidate) {
      const peer = peerRef.current
      if (peer && message.callId !== callIdRef.current) return

      if (peer?.remoteDescription) {
        await peer.addIceCandidate(message.candidate)
      } else {
        pendingIceRef.current.push(message)
      }
      return
    }

    if (message.type === 'offer') {
      if (message.description?.type !== 'offer' || typeof message.description.sdp !== 'string') return
      const stream = streamRef.current

      if (!stream) {
        pendingIceRef.current = []
        send(socket, { type: 'not-ready', callId: message.callId })
        setStatus('Включи камеру и попроси собеседника позвонить снова')
        return
      }

      if (peerRef.current) {
        // При одновременном вызове обе стороны выбирают один и тот же offer.
        // Второе соединение закрываем до применения нового SDP.
        if (peerRef.current.connectionState === 'connected' || callIdRef.current <= message.callId) return
        closeCall()
      }

      setStatus('Принимаем звонок…')
      const peer = createPeer(socket, stream, message.callId)
      await applyRemoteDescription(peer, message.description)
      if (peerRef.current !== peer) return

      const answer = await peer.createAnswer()
      if (peerRef.current !== peer) return
      await peer.setLocalDescription(answer)

      if (peerRef.current === peer) {
        send(socket, { type: 'answer', callId: message.callId, description: peer.localDescription })
      }
      return
    }

    if (message.type === 'answer') {
      const peer = peerRef.current
      if (message.callId !== callIdRef.current || message.description?.type !== 'answer') return
      if (peer?.signalingState !== 'have-local-offer') return

      await applyRemoteDescription(peer, message.description)

      if (peerRef.current === peer) {
        console.log('Ответ принят')
      }
    }
  }

  function connectSocket() {
    if (socketRef.current || !streamRef.current) return

    const socket = new WebSocket(SIGNALING_URL)
    socketRef.current = socket
    setSocketState('connecting')
    setStatus('Подключаемся к серверу…')

    socket.onopen = () => {
      if (socketRef.current !== socket) return
      setSocketState('open')
      setStatus('Подключились к серверу. Нажми «Позвонить» в одном из двух окон')
      send(socket, { type: 'ready' })
    }

    // Обрабатываем сообщения по очереди, даже если внутри есть await.
    let messageQueue = Promise.resolve()

    socket.onmessage = (event) => {
      messageQueue = messageQueue
        .then(() => {
          if (socketRef.current === socket) {
            return handleMessage(socket, event.data)
          }
        })
        .catch((error) => {
          if (socketRef.current !== socket) return
          console.error('Ошибка обработки сообщения:', error)
          closeCall()
          setStatus('Ошибка настройки звонка. Подробности в консоли')
        })
    }

    socket.onerror = () => {
      if (socketRef.current === socket) setStatus('Ошибка соединения с сервером')
    }

    socket.onclose = () => {
      if (socketRef.current !== socket) return

      socketRef.current = null
      setSocketState('closed')
      closeCall()
      setStatus('Связь с сервером закрыта. Возможно, подключился третий участник. Подключись снова')
    }
  }

  async function startCall() {
    const socket = socketRef.current
    const stream = streamRef.current

    if (socket?.readyState !== WebSocket.OPEN) {
      setStatus('Сначала подключись к серверу')
      return
    }

    if (!stream) {
      setStatus('Сначала включи камеру')
      return
    }

    if (peerRef.current) return

    closeCall()
    setStatus('Вызываем собеседника…')

    let peer
    try {
      const callId = crypto.randomUUID()
      peer = createPeer(socket, stream, callId)
      const offer = await peer.createOffer()
      if (peerRef.current !== peer) return
      await peer.setLocalDescription(offer)

      if (peerRef.current === peer) {
        send(socket, { type: 'offer', callId, description: peer.localDescription })
        console.log('Передали offer в send(), WebSocket:', socket.readyState)
      }
    } catch (error) {
      if (socketRef.current !== socket || peerRef.current !== peer) return
      console.error('Не удалось начать звонок:', error)
      closeCall()
      setStatus('Не удалось начать звонок. Подробности в консоли')
    }
  }

  function exitRoom() {
    const socket = socketRef.current
    socketRef.current = null
    setSocketState('closed')
    socket?.close()
    closeCall()

    cameraRequestRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (localVideoRef.current) localVideoRef.current.srcObject = null
    setCameraState('off')

    setStatus('Ты вышел из собеседования')
  }

  return (
    <main>
      <h1>Видеособеседование 1 на 1</h1>
      <p role="status">{status}</p>

      <button onClick={startCamera} disabled={cameraState !== 'off'}>Включить камеру</button>
      <button onClick={connectSocket} disabled={cameraState !== 'on' || socketState !== 'closed'}>Подключиться к серверу</button>
      <button onClick={startCall} disabled={cameraState !== 'on' || socketState !== 'open' || callActive}>Позвонить</button>
      <button onClick={exitRoom}>Выйти</button>

      <h2>Вы</h2>
      <video ref={localVideoRef} autoPlay playsInline muted width="320" />

      <h2>Собеседник</h2>
      <video ref={remoteVideoRef} autoPlay playsInline controls width="320" />
    </main>
  )
}
