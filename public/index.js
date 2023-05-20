//index.js
const io = require('socket.io-client')
const mediasoupClient = require('mediasoup-client')

const roomName = window.location.pathname.split('/')[2]

const socket = io("/mediasoup")

socket.on('connection-success', ({ socketId }) => {
  console.log(socketId)
  getLocalStream()
})

let isShareScreen;

let device
let rtpCapabilities
let producerTransport
let consumerTransports = []
let audioProducer
let videoProducer
let screenVideoProducer
let screenAudioProducer
let consumer

let isProducer = false
let isturnOnShareScreen = false
let isturnOffCamera = false
let isturnOffMic = false

// https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerOptions
// https://mediasoup.org/documentation/v3/mediasoup-client/api/#transport-produce
let params = {
  // mediasoup params
  encodings: [
    {
      rid: 'r0',
      maxBitrate: 100000,
      scalabilityMode: 'S1T3',
    },
    {
      rid: 'r1',
      maxBitrate: 300000,
      scalabilityMode: 'S1T3',
    },
    {
      rid: 'r2',
      maxBitrate: 900000,
      scalabilityMode: 'S1T3',
    },
  ],
  // https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerCodecOptions
  codecOptions: {
    videoGoogleStartBitrate: 1000
  },
  
}

let audioParams;
let videoParams = { params };
let consumingTransports = [];

const streamSuccess = (stream) => {
  localVideo.srcObject = stream
  isShareScreen = false
  audioParams = { track: stream.getAudioTracks()[0] , appData: {isShareScreen: isShareScreen}};
  videoParams = { track: stream.getVideoTracks()[0], ...videoParams, appData: {isShareScreen: isShareScreen} };
  console.log("Video track:", stream.getVideoTracks()[0])

  joinRoom()
}

const joinRoom = () => {
  socket.emit('joinRoom', { roomName }, (data) => {
    console.log(`Router RTP Capabilities... ${data.rtpCapabilities}`)
    // we assign to local variable and will be used when
    // loading the client Device (see createDevice above)
    rtpCapabilities = data.rtpCapabilities

    // once we have rtpCapabilities from the Router, create Device
    createDevice()
  })
}

const getLocalStream = () => {
  navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true
  })
    .then(streamSuccess)
    .catch(error => {
      console.log(error.message)
    })
}

// A device is an endpoint connecting to a Router on the
// server side to send/recive media
const createDevice = async () => {
  try {
    device = new mediasoupClient.Device()

    // https://mediasoup.org/documentation/v3/mediasoup-client/api/#device-load
    // Loads the device with RTP capabilities of the Router (server side)
    await device.load({
      // see getRtpCapabilities() below
      routerRtpCapabilities: rtpCapabilities
    })
    console.log('Device RTP Capabilities', device.rtpCapabilities)

    // once the device loads, create transport
    createSendTransport()

  } catch (error) {
    console.log(error)
    if (error.name === 'UnsupportedError')
      console.warn('browser not supported')
  }
}

const createSendTransport = () => {
  // see server's socket.on('createWebRtcTransport', sender?, ...)
  // this is a call from Producer, so sender = true
  socket.emit('createWebRtcTransport', { consumer: false }, ({ params }) => {
    // The server sends back params needed 
    // to create Send Transport on the client side
    if (params.error) {
      console.log(params.error)
      return
    }

    console.log(`Paramm ${params}`)

    // creates a new WebRTC Transport to send media
    // based on the server's producer transport params
    // https://mediasoup.org/documentation/v3/mediasoup-client/api/#TransportOptions
    producerTransport = device.createSendTransport(params)

    // https://mediasoup.org/documentation/v3/communication-between-client-and-server/#producing-media
    // this event is raised when a first call to transport.produce() is made
    // see connectSendTransport() below
    producerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        // Signal local DTLS parameters to the server side transport
        // see server's socket.on('transport-connect', ...)
        await socket.emit('transport-connect', {
          dtlsParameters,
        })

        // Tell the transport that parameters were transmitted.
        callback()

      } catch (error) {
        errback(error)
      }
    })

    producerTransport.on('produce', async (parameters, callback, errback) => {

      try {
        // tell the server to create a Producer
        // with the following parameters and produce
        // and expect back a server side producer id
        // see server's socket.on('transport-produce', ...)
        await socket.emit('transport-produce', {
          kind: parameters.kind,
          rtpParameters: parameters.rtpParameters,
          appData: parameters.appData,
        }, ({ id, producersExist }) => {
          // Tell the transport that parameters were transmitted and provide it with the
          // server side producer's id.
          callback({ id })

          // if producers exist, then join room
          if (producersExist) getProducers()
        })
      } catch (error) {
        errback(error)
      }
    })

    connectSendTransport()
  })
}


const connectSendTransport = async () => {
  // we now call produce() to instruct the producer transport
  // to send media to the Router
  // https://mediasoup.org/documentation/v3/mediasoup-client/api/#transport-produce
  // this action will trigger the 'connect' and 'produce' events above
  isShareScreen = false
  audioProducer = await producerTransport.produce(audioParams);
  videoProducer = await producerTransport.produce(videoParams);

  audioProducer.on('trackended', () => {
    console.log('audio track ended')

  })

  audioProducer.on('transportclose', () => {
    console.log('audio transport ended')

  })

  videoProducer.on('trackended', () => {
    console.log('video track ended')

  })

  videoProducer.on('transportclose', () => {
    console.log('video transport ended')

  })
}
// ___________________________________________________________________________________________________________________________________________
// _______________________________________________________CONSUMER____________________________________________________________________________
// ___________________________________________________________________________________________________________________________________________

const signalNewConsumerTransport = async (remoteProducerId) => {
  //check if we are already consuming the remoteProducerId
  if (consumingTransports.includes(remoteProducerId)) return;
  consumingTransports.push(remoteProducerId);

  await socket.emit('createWebRtcTransport', { consumer: true }, ({ params }) => {
    // The server sends back params needed 
    // to create Send Transport on the client side
    if (params.error) {
      console.log(params.error)
      return
    }
    console.log(`PARAMS... ${params}`)

    let consumerTransport
    try {
      consumerTransport = device.createRecvTransport(params)
    } catch (error) {
      // exceptions: 
      // {InvalidStateError} if not loaded
      // {TypeError} if wrong arguments.
      console.log(error)
      return
    }

    consumerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        // Signal local DTLS parameters to the server side transport
        // see server's socket.on('transport-recv-connect', ...)
        await socket.emit('transport-recv-connect', {
          dtlsParameters,
          serverConsumerTransportId: params.id,
        })

        // Tell the transport that parameters were transmitted.
        callback()
      } catch (error) {
        // Tell the transport that something was wrong
        errback(error)
      }
    })

    connectRecvTransport(consumerTransport, remoteProducerId, params.id)
  })
}
// ________________________________________________________________________________________________________________________

// server informs the client of a new producer just joined
socket.on('new-producer', ({ producerId }) => signalNewConsumerTransport(producerId))
// _______________________________________________________________________________________________________________________

const getProducers = () => {
  socket.emit('getProducers', producerIds => {
    // for each of the producer create a consumer
    // producerIds.forEach(id => signalNewConsumerTransport(id))
    producerIds.forEach(signalNewConsumerTransport)
  })
}

// ______________________________________________________________________________________________________________________
let socketIDlist = []
let check = 1
const connectRecvTransport = async (consumerTransport, remoteProducerId, serverConsumerTransportId) => {
  // for consumer, we need to tell the server first
  // to create a consumer based on the rtpCapabilities and consume
  // if the router can consume, it will send back a set of params as below
  await socket.emit('consume', {
    rtpCapabilities: device.rtpCapabilities,
    remoteProducerId,
    serverConsumerTransportId,
  }, async ({ params }) => {
    if (params.error) {
      console.log('Cannot Consume')
      return
    }

    console.log('Consumer Params' ,params)
    
    // then consume with the local consumer transport
    // which creates a consumer
    const consumer = await consumerTransport.consume({
      id: params.id,
      producerId: params.producerId,
      kind: params.kind,
      rtpParameters: params.rtpParameters,
    })

    consumerTransports = [
      ...consumerTransports,
      { socketID: params.consumer_socketID,
        consumerTransport,
        serverConsumerTransportId: params.id,
        producerId: remoteProducerId,
        consumer,
        isShareScreen: params.consumer_isShareScreen==true? 'screen': 'cam'
      },
    ]
    console.log("consumerTransports::", consumerTransports)

    // create a new div element for the new consumer media
    const newElem = document.createElement('div')
    newElem.setAttribute('id', `td-${remoteProducerId}`)

    if (params.kind == 'audio') {
      //append to the audio container
      newElem.innerHTML = '<audio id="' + remoteProducerId + '" autoplay></audio>'
    } else {
      //append to the video container
      newElem.setAttribute('class', 'remoteVideo')
      newElem.innerHTML = '<video id="' + remoteProducerId + '" autoplay class="video" ></video>'
    }

    videoContainer.appendChild(newElem)

    // destructure and retrieve the video track from the producer
    const { track } = consumer
    console.log("Tr",[track])
    document.getElementById(remoteProducerId).srcObject = new MediaStream([track])

    // the server consumer started with media paused
    // so we need to inform the server to resume
    socket.emit('consumer-resume', { serverConsumerId: params.serverConsumerId })

    // ------------------Participant Area Added--------------------------------------------------------------------------------------------
    var participant_Column = document.querySelector('.participantsColumn');
    //Add socketID (if socketID already existed, not add)
    if (!socketIDlist.includes(params.consumer_socketID)) {
      socketIDlist.push(params.consumer_socketID);
      var participant_div = `<div id="par-${params.consumer_socketID}">
                              <p> ${params.consumer_socketID} </p>
                              <div id="cam-${params.consumer_socketID}">
                                <h6> Cam: 
                                  <button id="cam-video-${params.consumer_socketID}" name="on" class="button2">Cam</button>
                                  <button id="cam-audio-${params.consumer_socketID}" name="on" class="button2">Mic</button>
                                </h6>
                              </div>
                              <div id="screen-${params.consumer_socketID}">
                                <h6> Sreen shared: 
                                  <button id="screen-video-${params.consumer_socketID}" name="on" class="button2">Cam</button>
                                  <button id="screen-audio-${params.consumer_socketID}" name="on" class="button2">Mic</button>
                                </h6>
                              </div>
                            </div>`
      participant_Column.insertAdjacentHTML("beforeend", participant_div)
    }
    
    if(params.consumer_isShareScreen==false){
      // -------------------------Turn the Camera consumer--------------
      if(params.kind=='video'){
        let cam_video_btn = document.getElementById(`cam-video-${params.consumer_socketID}`)
        cam_video_btn.classList.toggle('button2');
        cam_video_btn.addEventListener('click', function(){
          //if consumer is closed, button is freeze
          if(consumerTransports.find(transportData => transportData.producerId === remoteProducerId)===undefined){return}

          var nameValue = cam_video_btn.getAttribute("name");
          if(nameValue=="on"){
            console.log("cam-off")
            consumer.pause()
            cam_video_btn.setAttribute('name', "off")
            cam_video_btn.classList.toggle('button2');
          }
          if(nameValue=="off"){
            console.log("cam-on")
            consumer.resume()
            cam_video_btn.setAttribute('name', "on")
            cam_video_btn.classList.toggle('button2');
          }
        })
      }
      // -------------------------Turn the mic consumer--------------
      if(params.kind=='audio'){
        let cam_audio_btn = document.getElementById(`cam-audio-${params.consumer_socketID}`)
        cam_audio_btn.classList.toggle('button2');
        cam_audio_btn.addEventListener('click', function(){
          //if consumer is closed, button is freeze
          if(consumerTransports.find(transportData => transportData.producerId === remoteProducerId)===undefined){return}

          var nameValue = cam_audio_btn.getAttribute("name");
          if(nameValue=="on"){
            console.log("mic-off")
            consumer.pause()
            cam_audio_btn.setAttribute('name', "off")
            cam_audio_btn.classList.toggle('button2');
          }
          if(nameValue=="off"){
            console.log("mic-on")
            consumer.resume()
            cam_audio_btn.setAttribute('name', "on")
            cam_audio_btn.classList.toggle('button2');
          }
        })
      }
    }
    // ----------------if isShareScreen of cosumer is True--------------------
    if(params.consumer_isShareScreen==true){
      // -------------------------Turn the screen Camera consumer--------------
      if(params.kind=='video'){
        let screen_video_btn = document.getElementById(`screen-video-${params.consumer_socketID}`)
        screen_video_btn.classList.toggle('button2');
        screen_video_btn.addEventListener('click', function(){
          //if consumer is closed, button is freeze
          console.log(3)
          if(consumerTransports.find(transportData => transportData.producerId === remoteProducerId)===undefined){return}
          console.log(4)
          var nameValue = screen_video_btn.getAttribute("name");
          if(nameValue=="on"){
            console.log("screen-cam-off")
            consumer.pause()
            screen_video_btn.setAttribute('name', "off")
            screen_video_btn.classList.toggle('button2');
          }
          if(nameValue=="off"){
            console.log("screen-cam-on")
            consumer.resume()
            screen_video_btn.setAttribute('name', "on")
            screen_video_btn.classList.toggle('button2');
          }
        })
      }
      // -------------------------Turn the mic consumer--------------
      if(params.kind=='audio'){
        let screen_audio_btn = document.getElementById(`screen-audio-${params.consumer_socketID}`)
        screen_audio_btn.classList.toggle('button2');
        screen_audio_btn.addEventListener('click', function(){
          //if consumer is closed, button is freeze
          if(consumerTransports.find(transportData => transportData.producerId === remoteProducerId)===undefined){return}

          var nameValue = screen_audio_btn.getAttribute("name");
          if(nameValue=="on"){
            console.log("screen-mic-off")
            consumer.pause()
            screen_audio_btn.setAttribute('name', "off")
            screen_audio_btn.classList.toggle('button2');
          }
          if(nameValue=="off"){
            console.log("screen-mic-on")
            consumer.resume()
            screen_audio_btn.setAttribute('name', "on")
            screen_audio_btn.classList.toggle('button2');
          }
        })
      }
    }
    
    
    // ------------------------------End-------------------------------

  })
}

// ___________________________________________________________________________________________________________________________________________________________

socket.on('producer-closed', ({ remoteProducerId }) => {
  // server notification is received when a producer is closed
  // we need to close the client-side consumer and associated transport
  console.log("procedudd",remoteProducerId)
  const producerToClose = consumerTransports.find(transportData => transportData.producerId === remoteProducerId)
  if(producerToClose==null){
    return
  }
  
  let consumer_socketid = producerToClose.socketID
  
  producerToClose.consumerTransport.close()
  producerToClose.consumer.close()

  // remove the consumer transport from the list
  consumerTransports = consumerTransports.filter(transportData => transportData.producerId !== remoteProducerId)

  // remove the video div element
  videoContainer.removeChild(document.getElementById(`td-${remoteProducerId}`))
  //COunt how many number of consumer come from a socketID is existing(if it ==0, close a participant div)
  let num_consumer_of_socketID = consumerTransports.filter(transportData => transportData.socketID === consumer_socketid).length
  if(num_consumer_of_socketID==0){
    var participant_Column = document.querySelector('.participantsColumn');
    participant_Column.removeChild(document.getElementById(`par-${consumer_socketid}`))
  }
  else{
    let button_deleted = document.getElementById(`${producerToClose.isShareScreen}-${producerToClose.consumer.kind}-${consumer_socketid}`)
    button_deleted.classList.toggle('button2');
    check = 2
  }

})


// _________________________________________________________________Turn on Share Screen ___________________________________________________________________

let stream2
let isturnOffCameraShareScreen = false
let isturnOffMicShareScreen = false
let id_shareScreen=null

const getShareScreenPausedState = () => {
  // clicked_sharescreen
  let btnLocalScreen = document.getElementById('btnLocalScreen')
  if (isturnOnShareScreen == false) {
    isturnOnShareScreen = true
    btnLocalScreen.classList.toggle('button-clicked_sharescreen');
    console.log("screen on")
    // ------------Add HTML localShareScreen------------
    var tdElement = document.querySelector('.ShareScreen');

    const newEle = document.createElement('video')
    newEle.setAttribute('id', "localShareScreen")
    newEle.setAttribute('class', "video")
    newEle.setAttribute('autoplay', '')

    const btnCamShareScreen = document.createElement('button')
    btnCamShareScreen.setAttribute('id', "btnCamShareScreen")
    btnCamShareScreen.innerHTML = 'Camera'

    const btnMicShareScreen = document.createElement('button')
    btnMicShareScreen.setAttribute('id', "btnMicShareScreen")
    btnMicShareScreen.innerHTML = 'Mic'

    if (tdElement) {
      tdElement.appendChild(newEle);
      tdElement.appendChild(btnCamShareScreen);
      tdElement.appendChild(btnMicShareScreen);
    }
    isButtonCreated = true
    // -------------Send the media by exist producer------------------

    connectSendTransport2()
    btnCamShareScreen.addEventListener('click', getCamShareScreenPausedState)
    btnMicShareScreen.addEventListener('click', getMicShareScreenPausedState)
    return
  }

  // _____________TURN OFF SHARE SCREEN__________
  if (isturnOnShareScreen == true) {
    isturnOnShareScreen = false
    console.log("screen off")
    btnLocalScreen.classList.toggle('button-clicked_sharescreen');

    id_shareScreen = screenVideoProducer.id
    socket.emit('producerClose', { id_shareScreen });
    screenVideoProducer.close()
    if (screenAudioProducer) {
      screenAudioProducer.close()
    }
    stream2 = null
    screenVideoProducer = null
    screenAudioProducer = null
    

    var shareScreenContainer = document.querySelector('.ShareScreen');
    shareScreenContainer.removeChild(document.getElementById('localShareScreen'))
    shareScreenContainer.removeChild(document.getElementById('btnCamShareScreen'))
    shareScreenContainer.removeChild(document.getElementById('btnMicShareScreen'))

    return
  }
}



const connectSendTransport2 = async () => {
  stream2 = null;
  stream2 = await navigator.mediaDevices.getDisplayMedia({
    video:{
      displaySurface : 'monitor',
      logicalSurface : true,
      cursor         : true,
      width          : { max: 1920 },
      height         : { max: 1080 },
      frameRate      : { max: 30 }
    },
    audio: true
  })
  
  let localShareScreen = document.getElementById("localShareScreen");
  let newStream = new MediaStream();
  stream2.getTracks().forEach(track => newStream.addTrack(track));
  localShareScreen.srcObject = newStream;
  console.log("check THe trackk: ",stream2.getVideoTracks()[0])

  let audioScreenparams
  let videoScreenparams = { params }; //Phai khai bao vide param o day neu khong se bi loi.
  isShareScreen=true
  audioScreenparams = {track: stream2.getAudioTracks()[0] ,appData: {isShareScreen: isShareScreen}};
  videoScreenparams = {track: stream2.getVideoTracks()[0], ...videoScreenparams, appData: {isShareScreen: isShareScreen} };

  isShareScreen = true
  console.log("track is opened?:", stream2.getVideoTracks()[0].readyState)
  screenVideoProducer = await producerTransport.produce(videoScreenparams);
  screenVideoProducer.track.onended = async () => {
    console.log("DONg track cmnr")
  }
  //---------------Neu may tinh co audio(CHi co tren Window moi co audio cho share screen neu khong thi ta share tab cung se co audio)
  if (stream2.getAudioTracks().length) {
    screenAudioProducer = await producerTransport.produce(audioScreenparams);


    screenAudioProducer.on('trackended', () => {
      console.log('audio track ended')
      // close audio track
    })

    screenAudioProducer.on('transportclose', () => {
      console.log('audio transport ended')

      // close audio track
    })
  }

  screenVideoProducer.on('trackended', () => {
    console.log('video track ended')
    getShareScreenPausedState()

    // close video track
  })

  screenVideoProducer.on('transportclose', () => {
    console.log('video transport ended')

    // close video track
  })

  

}
// -----------------Turn off Cam Share Screen---------------

const getCamShareScreenPausedState = () => {

  let btnLocalVideo = document.getElementById('btnCamShareScreen');
  if (isturnOffCameraShareScreen == false) {
    isturnOffCameraShareScreen = true
    btnLocalVideo.classList.toggle('button-clicked_camera_share_screen');

    changeCamPaused2()
    return
  }
  if (isturnOffCameraShareScreen == true) {
    isturnOffCameraShareScreen = false
    btnLocalVideo.classList.toggle('button-clicked_camera_share_screen');

    changeCamPaused2()
    return
  }
}

const changeCamPaused2 = async () => {
  if (isturnOffCameraShareScreen == true) {

    if (screenVideoProducer) {
      try {
        // await sig('pause-producer', { producerId: producer.id });
        await screenVideoProducer.pause();
      } catch (e) {
        console.error(e);
      }
    }
  } else {
    if (screenVideoProducer) {
      try {
        // await sig('resume-producer', { producerId: producer.id });
        await screenVideoProducer.resume();
      } catch (e) {
        console.error(e);
      }
    }
  }
}
// -----------------Turn off Mic Share Screen--------------

const getMicShareScreenPausedState = () => {
  let btnLocalAudio = document.getElementById('btnMicShareScreen');
  if (isturnOffMicShareScreen == false) {
    isturnOffMicShareScreen = true
    btnLocalAudio.classList.toggle('button-clicked_mic_share_screen');
    console.log("on")
    changeMicPaused2()
    return
  }
  if (isturnOffMicShareScreen == true) {
    isturnOffMicShareScreen = false
    console.log("off")
    btnLocalAudio.classList.toggle('button-clicked_mic_share_screen');
    changeMicPaused2()
    return
  }
}

const changeMicPaused2 = async () => {
  if (isturnOffMicShareScreen == true) {
    console.log("akllllkks")
    if (screenAudioProducer) {
      try {
        await screenAudioProducer.pause();
      } catch (e) {
        console.error(e);
      }
    }
  } else {
    if (screenAudioProducer) {
      try {
        await screenAudioProducer.resume();
      } catch (e) {
        console.error(e);
      }
    }
  }
}

//_______________________________________________________________Turn off Cam____________________________________________________________________________


const getCamPausedState = () => {
  let btnLocalVideo = document.getElementById('btnLocalVideo');
  if (isturnOffCamera == false) {
    isturnOffCamera = true
    btnLocalVideo.classList.toggle('button-clicked_camera');
    console.log("on")
    changeCamPaused()
    return
  }
  if (isturnOffCamera == true) {
    isturnOffCamera = false
    console.log("off")
    btnLocalVideo.classList.toggle('button-clicked_camera');
    changeCamPaused()
    return
  }
}

const changeCamPaused = async () => {
  if (isturnOffCamera == true) {
    console.log("aklkks")
    if (videoProducer) {
      try {
        // await sig('pause-producer', { producerId: producer.id });
        await videoProducer.pause();
      } catch (e) {
        console.error(e);
      }
    }
    // pauseProducer(videoProducer);
  } else {
    if (videoProducer) {
      try {
        // await sig('resume-producer', { producerId: producer.id });
        await videoProducer.resume();
      } catch (e) {
        console.error(e);
      }
    }
    // resumeProducer(videoProducer);
  }
}


//_______________________________________________________________Turn off Mic____________________________________________________________________________
const getMicPausedState = () => {
  let btnLocalAudio = document.getElementById('btnLocalAudio');
  if (isturnOffMic == false) {
    isturnOffMic = true
    btnLocalAudio.classList.toggle('button-clicked_mic');
    console.log("on")
    changeMicPaused()
    return
  }
  if (isturnOffMic == true) {
    isturnOffMic = false
    console.log("off")
    btnLocalAudio.classList.toggle('button-clicked_mic');
    changeMicPaused()
    return
  }
}

const changeMicPaused = async () => {
  if (isturnOffMic == true) {
    console.log("akllllkks")
    if (audioProducer) {
      try {
        // await sig('pause-producer', { producerId: producer.id });
        await audioProducer.pause();
      } catch (e) {
        console.error(e);
      }
    }
    // pauseProducer(audioProducer);
  } else {
    if (audioProducer) {
      try {
        // await sig('resume-producer', { producerId: producer.id });
        await audioProducer.resume();
      } catch (e) {
        console.error(e);
      }
    }
    // resumeProducer(audioProducer);
  }
}

// _________________________________________________________Buttons_________________________________________________________________
btnLocalVideo.addEventListener('click', getCamPausedState)
btnLocalAudio.addEventListener('click', getMicPausedState)
btnLocalScreen.addEventListener('click', getShareScreenPausedState)

// btnCamShareScreen.addEventListener('click',getCamShareScreenPausedState)
// btnMicShareScreen.addEventListener('click',getMicShareScreenPausedState)
