// botAvatar.component.js
(function () {
  "use strict";

  angular.module("AvatarPocApp").component("botAvatar", {
    templateUrl: "botAvatar.tpl.html",
    bindings: {
      textPrompt: "<",
      onStartSpeaking: "&",
      onStopSpeaking: "&",
      onSessionError: "&",
      onStatusChange: "&",
      apiKey: "<",
    },
    controller: BotAvatarController,
    controllerAs: "vm",
  });

  function BotAvatarController($scope) {
    var vm = this;

    // --- Configuration ---
    const API_CONFIG = {
      // NEW: Updated Base URL
      serverUrl: "https://api.liveavatar.com",
    };

    // NEW: Configuration for the session
    // Note: 'CUSTOM' mode is used when you want to control the avatar via API (Repeat/Chat)
    // rather than using LiveAvatar's built-in LLM ('FULL' mode).
    const SESSION_CONFIG = {
      mode: "FULL",
      avatar_id: "bf00036b-558a-44b5-b2ff-1e3cec0f4ceb",
      is_sandbox: false,
      avatar_persona: { voice_id: "62bbb4b2-bb26-4727-bc87-cfb2bd4e0cc8" },
      interactivity_type: "PUSH_TO_TALK",

      session_idle_timeout: 600,

      // 2. Add the legacy/SDK key just in case
      activity_idle_timeout: 600,
    };

    let sessionTimer = null;
    let keepAliveInterval = null; // NEW: Keep-alive timer
    const KEEP_ALIVE_INTERVAL_MS = 30 * 1000; // 1 minute
    const SESSION_DURATION_MS = 19 * 60 * 1000; // 20 minutes for LiveAvatar
    // --- Internal State ---
    let isReady = false;
    let isSpeaking = false;
    let isRefreshing = false;
    let sessionInfo = null; // Stores session_id, url, tokens
    let room = null;
    let sessionToken = null; // Token from step 1
    let mediaElement = null;

    // --- Reconnection State ---
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 3;
    let reconnectTimeoutId = null;

    // --- Component Lifecycle Hooks ---
    vm.$onInit = function () {
      logHighlight("👋 Initializing Component...", "#3b82f6");
      updateStatus("👋 Component Initializing...");
      mediaElement = document.getElementById("mediaElement");
      if (!mediaElement) {
        updateStatus("❌ CRITICAL: Video element not found.");
        return;
      }
      mediaElement.autoplay = true;

      initializeAndConnect();
    };

    vm.$onChanges = function (changes) {
      if (isReady && changes.textPrompt && changes.textPrompt.currentValue) {
        const text = changes.textPrompt.currentValue;
        updateStatus(`▶️ Received new text prompt: "${text}"`);
        // We default to 'repeat' task type for direct text input
        sendText(text);
      }
    };

    vm.$onDestroy = function () {
      updateStatus("🚪 Component destroying. Closing session...");
      logHighlight("🚪 Disconnecting...", "#ef4444");
      if (reconnectTimeoutId) clearTimeout(reconnectTimeoutId);
      if (sessionTimer) clearTimeout(sessionTimer);
      stopKeepAliveHeartbeat(); // NEW: Stop keep-alive
      closeSession();
    };

    /**
     * Updated Initialization Flow for LiveAvatar API
     */
    async function initializeAndConnect() {
      try {
        updateStatus("🚀 Attempting to start a new LiveAvatar session...");

        // Step 1: Create Session Token
        await createSessionToken();

        // Step 2: Start Session (Spins up the avatar)
        await startSession();

        // Step 3: Connect to LiveKit
        await connectToLiveKit();
        // startSessionTimer();
        logHighlight("connected", "#22c55e");

        updateStatus("✅ Session is ready and streaming!");
        
        // NEW: Start Keep-Alive Heartbeat
        startKeepAliveHeartbeat();
        
        reconnectAttempts = 0;
        isReady = true;
      } catch (error) {
        updateStatus(`❌ Session failed to start: ${error.message}`);
        attemptReconnect();
      }
    }

    // --- New LiveAvatar API Functions ---

    // 1. Create Session Token
    async function createSessionToken() {
      const response = await fetch(
        `${API_CONFIG.serverUrl}/v1/sessions/token`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": vm.apiKey, // Auth via API Key
          },
          // Configuration happens here now
          body: JSON.stringify(SESSION_CONFIG),
        },
      );

      if (!response.ok)
        throw new Error(`API Error (Token): ${response.statusText}`);

      const data = await response.json();
      // The API returns 'data.session_token' which we need for the next step
      sessionToken = data.data.session_token;
      // We might also get a session_id here, but we rely on the next step for full details
      updateStatus("🔑 Session token obtained.");
    }

    // 2. Start Session
    async function startSession() {
      if (!sessionToken) throw new Error("No session token available.");

      const response = await fetch(
        `${API_CONFIG.serverUrl}/v1/sessions/start`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Use the token from Step 1 as Bearer
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({
            // Optional: Pass specific LiveKit config here if needed (e.g. 'custom' mode)
            // If empty, LiveAvatar provides the room (default behavior)
            livekit_config: {
              url: "wss://your-custom-region.livekit.cloud", // <--- YOU CONTROL THIS
              token: "ey...", // <--- Token you generated for the Avatar to join
            },
          }),
        },
      );

      if (!response.ok)
        throw new Error(`API Error (Start): ${response.statusText}`);

      const data = await response.json();
      sessionInfo = data.data; // Contains livekit_url, livekit_client_token, session_id
      updateStatus(`🎬 Session started. ID: ${sessionInfo.session_id}`);
    }

    // 3. Connect to LiveKit (Updated)
    async function connectToLiveKit() {
      if (room) {
        room.removeAllListeners(LivekitClient.RoomEvent.Disconnected);
        room.disconnect();
      }

      // Initialize LiveKit Room
      room = new LivekitClient.Room({
        adaptiveStream: true,
        dynacast: true,
      });

      // Handle Media Tracks (Video/Audio)
      room.on(
        LivekitClient.RoomEvent.TrackSubscribed,
        (track, publication, participant) => {
          // if (track.kind === "video" || track.kind === "audio") {
          //   if (!mediaElement.srcObject) {
          //     mediaElement.srcObject = new MediaStream();
          //   }
          //   mediaElement.srcObject.addTrack(track.mediaStreamTrack);
          // }

          // if (track.kind === "video") {
          //   // We use 'onresize' or 'onloadeddata' as a proxy for "frame received"
          //   // or we can simply attach the element and wait a tiny bit.
          //   track.attach(mediaElement);

          //   // Listener for when video is actually playing pixels
          //   mediaElement.onplaying = function () {
          //     updateStatus("👁️ Video stream is playing, fading in...");
          //     setVideoVisibility(true);
          //   };
          // }

          if (!mediaElement.srcObject) {
            mediaElement.srcObject = new MediaStream();
          }

          // 2. Add the track to the stream
          mediaElement.srcObject.addTrack(track.mediaStreamTrack);

          // 3. NEW: Specific handling for Audio
          if (track.kind === "audio") {
            // Explicitly Attach (LiveKit helper ensures mobile compatibility)
            track.attach(mediaElement);

            // FORCE PLAY: Ensure the browser plays the new audio track
            mediaElement.muted = false;
            mediaElement
              .play()
              .catch((e) => console.log("Audio autoplay check:", e));
            updateStatus("🔊 Audio track received and attached.");
          }

          // 4. Specific handling for Video (Existing fade-in logic)
          if (track.kind === "video") {
            track.attach(mediaElement);
            mediaElement.onplaying = function () {
              updateStatus("👁️ Video stream is playing, fading in...");
              setVideoVisibility(true);
            };
          }
        },
      );

      // Handle Data Messages (Events from Avatar)
      // room.on(
      //   LivekitClient.RoomEvent.DataReceived,
      //   (payload, participant, kind, topic) => {
      //     const strData = new TextDecoder().decode(payload);
      //     try {
      //       const msg = JSON.parse(strData);
      //       // Event names might slightly differ in new API, keeping standard checks
      //       if (
      //         msg.type === "avatar_start_speaking" ||
      //         msg.type === "start_speaking"
      //       ) {
      //         isSpeaking = true;
      //         if (vm.onStartSpeaking) vm.onStartSpeaking();
      //       } else if (
      //         msg.type === "avatar_stop_talking" ||
      //         msg.type === "stop_speaking"
      //       ) {
      //         isSpeaking = false;
      //         if (vm.onStopSpeaking) vm.onStopSpeaking();
      //       }
      //     } catch (e) {
      //       // updateStatus("Received raw data: " + strData);
      //     }
      //   }
      // );

      room.on(
        LivekitClient.RoomEvent.DataReceived,
        (payload, participant, kind, topic) => {
          // NEW: Only listen to server events on 'agent-response'
          if (topic !== "agent-response") return;

          const strData = new TextDecoder().decode(payload);
          try {
            const msg = JSON.parse(strData);

            // NEW: Handle new Event Types
            if (msg.event_type === "avatar.speak_started") {
              isSpeaking = true;
              if (vm.onStartSpeaking) vm.onStartSpeaking();
              updateStatus("🗣️ Avatar started speaking");
            } else if (msg.event_type === "avatar.speak_ended") {
              isSpeaking = false;
              if (vm.onStopSpeaking) vm.onStopSpeaking();
              updateStatus("🤫 Avatar stopped speaking");
            }
          } catch (e) {
            console.error("Error parsing data message:", e);
          }
        },
      );

      room.on(
        LivekitClient.RoomEvent.ConnectionQualityChanged,
        (connectionQuality, participant) => {
          // We only care about the local participant's connection to the server
          if (participant.sid !== room.localParticipant.sid) return;

          let qualityText = "Unknown";
          let color = "#9ca3af"; // gray

          switch (connectionQuality) {
            case LivekitClient.ConnectionQuality.Excellent:
              qualityText = "Excellent";
              color = "#22c55e"; // green
              break;
            case LivekitClient.ConnectionQuality.Good:
              qualityText = "Good";
              color = "#84cc16"; // lime
              break;
            case LivekitClient.ConnectionQuality.Poor:
              qualityText = "Poor";
              color = "#f59e0b"; // amber
              break;
            case LivekitClient.ConnectionQuality.Lost:
              qualityText = "Lost";
              color = "#ef4444"; // red
              break;
          }

          // Log specific quality changes
          logHighlight(`Signal Quality: ${qualityText}`, color);

          // If quality drops to Poor or Lost, we might want to warn the user
          if (
            connectionQuality === LivekitClient.ConnectionQuality.Poor ||
            connectionQuality === LivekitClient.ConnectionQuality.Lost
          ) {
            updateStatus(`⚠️ Connection instability detected: ${qualityText}`);
          }
        },
      );

      room.on(LivekitClient.RoomEvent.Disconnected, (reason) => {
        if (isRefreshing) {
          updateStatus("🔌 Manual disconnect for refresh (Ignored).");
          return;
        }
        isReady = false;
        logHighlight(`🔌 Disconnected: ${reason}`, "#f97316");
        updateStatus(`🔌 Room disconnected: ${reason}`);
        if (
          reason === LivekitClient.DisconnectReason.NETWORK_ERROR ||
          reason === LivekitClient.DisconnectReason.UNKNOWN
        ) {
          attemptReconnect();
        } else {
          triggerError("Avatar session ended.");
        }
      });

      // Connect using the URL and Token returned from 'startSession'
      await room.connect(
        sessionInfo.livekit_url,
        sessionInfo.livekit_client_token,
      );
      updateStatus("🔗 Connected to LiveKit room.");

      isRefreshing = false;
    }

    // --- Updated: Send Text via Data Channel ---
    // The new API recommends using LiveKit Data Channels for commands instead of HTTP REST
    // async function sendText(text, taskType) {
    //   if (!isReady || !room) {
    //     updateStatus("⚠️ Cannot send text, session not ready.");
    //     return;
    //   }
    //   isSpeaking = true;
    //   updateStatus(`📤 Sending text: "${text}"`);

    //   // Construct Command Payload
    //   // Note: Verify exact JSON structure in LiveAvatar docs; this is the standard pattern.
    //   const commandPayload = JSON.stringify({
    //     type: "speak", // Command type
    //     text: text,
    //     task_type: taskType, // 'repeat' or 'chat'
    //   });

    //   const dataEncoder = new TextEncoder();
    //   const data = dataEncoder.encode(commandPayload);

    //   try {
    //     // Publish data to the room (Reliable = true for commands)
    //     await room.localParticipant.publishData(data, {
    //       reliable: true,
    //       topic: "avatar_command", // specific topic if required by new API
    //     });
    //   } catch (error) {
    //     updateStatus(`⚠️ Error sending data: ${error.message}`);
    //   }
    // }

    async function sendText(text) {
      // ... (previous checks)

      // 1. Determine if we want it to just 'speak' (repeat) or 'chat' (respond)
      const eventType = "avatar.speak_text";

      // 2. Construct the payload
      const commandPayload = JSON.stringify({
        event_type: eventType,
        text: text, // <--- HERE is where you are sending the text
      });

      const dataEncoder = new TextEncoder();
      const data = dataEncoder.encode(commandPayload);

      // 3. Publish to 'agent-control' topic
      await room.localParticipant.publishData(data, {
        reliable: true,
        topic: "agent-control",
      });
    }

    // --- Helper Functions (Reconnect, Close, etc.) ---
    function attemptReconnect() {
      if (reconnectAttempts >= maxReconnectAttempts) {
        updateStatus("Giving up on reconnection.");
        triggerError("Failed to reconnect.");
        return;
      }
      const delay = Math.pow(2, reconnectAttempts) * 1000;
      reconnectAttempts++;
      logHighlight(`⚠️ Retrying connection...`, "#eab308");
      updateStatus(`Retrying in ${delay / 1000}s...`);
      reconnectTimeoutId = setTimeout(initializeAndConnect, delay);
    }

    async function closeSession() {
      if (!sessionInfo) return;
      try {
        // STOP session endpoint
        await fetch(`${API_CONFIG.serverUrl}/v1/sessions/stop`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // For Stop, we might need the session token or just API key depending on auth
            // The docs say "If session token used... session_id not required"
            // But we'll pass headers just in case.
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({ session_id: sessionInfo.session_id }),
        });
        updateStatus("🛑 Session stopped on server.");
      } catch (error) {
        updateStatus(`⚠️ Error stopping: ${error.message}`);
      }
      stopKeepAliveHeartbeat(); // NEW: Create a clean cleanup
      if (room) room.disconnect();
      mediaElement.srcObject = null;
      isReady = false;
      sessionInfo = null;
    }

    function updateStatus(log) {
      console.log(`[BotAvatar] ${log} - ${new Date().toLocaleTimeString()}`);
    }

    function triggerError(message) {
      if (vm.onSessionError) vm.onSessionError({ message: message });
    }

    function logHighlight(message, color) {
      const styles = `color: ${color}; font-weight: bold; font-size: 14px; background: #f0f0f0; padding: 5px; border-left: 5px solid ${color};`;
      console.log(`%c [BotAvatar] ${message} `, styles);

      // This is what updates the UI text!
      if (vm.onStatusChange) {
        vm.onStatusChange({ status: message });
      }
    }

    // --- Add this NEW function ---
    function startSessionTimer() {
      // Clear any existing timer
      if (sessionTimer) clearTimeout(sessionTimer);

      updateStatus("⏳ Session timer started (1m 50s).");

      sessionTimer = setTimeout(function () {
        updateStatus("⏰ Session time limit reached. Refreshing session...");
        handleSessionTimeout();
      }, SESSION_DURATION_MS);
    }

    function handleSessionTimeout() {
      // 1. Fade out the live video.
      // This reveals the 'fallback-video.mov' which is running underneath.
      setVideoVisibility(false);
      logHighlight("♻️ Reconnecting (Background)...", "#eab308");
      isRefreshing = true;
      // 2. Wait a moment for the fade-out to finish (e.g., 500ms), then reconnect
      setTimeout(function () {
        // We do NOT use 'attemptReconnect' here because that increases the retry counter.
        // We want a fresh restart.

        // Stop the old room explicitly
        // if (room) {
        //     room.removeAllListeners(LivekitClient.RoomEvent.Disconnected);
        //     room.disconnect();
        // }

        // if (mediaElement) {
        //     mediaElement.srcObject = null;
        // }

        closeSession();

        // 2. Reset reconnection attempts so the new session gets a fresh start
        reconnectAttempts = 0;

        // Optional: Call stop session API if you want to be clean,
        // but for speed, we might just start the new one.
        // Let's stick to your initializeAndConnect flow which starts fresh.

        updateStatus(
          "🔄 Starting fresh session for background reconnection...",
        );
        initializeAndConnect();
      }, 500);
    }

    function setVideoVisibility(isVisible) {
      if (!mediaElement) return;
      if (isVisible) {
        mediaElement.classList.add("fade-in");
      } else {
        mediaElement.classList.remove("fade-in");
      }
    }

    // --- NEW: Keep-Alive Logic ---
    function startKeepAliveHeartbeat() {
      if (keepAliveInterval) clearInterval(keepAliveInterval);
      
      const intervalSec = KEEP_ALIVE_INTERVAL_MS / 1000;
      logHighlight(`💓 Starting keep-alive heartbeat (every ${intervalSec}s)`, "#ec4899");
      
      keepAliveInterval = setInterval(keepAliveSession, KEEP_ALIVE_INTERVAL_MS);
    }

    function stopKeepAliveHeartbeat() {
      if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
        logHighlight("sz Stopped keep-alive heartbeat", "#ec4899");
      }
    }

    async function keepAliveSession() {
      if (!sessionInfo || !sessionInfo.session_id) {
        console.warn("[BotAvatar] ⚠️ Keep-alive skipped: No session info.");
        return;
      }
      try {
        console.log(`[BotAvatar] 💓 Sending keep-alive request for session ${sessionInfo.session_id}...`);
        // endpoint: /v1/sessions/keep-alive
        const response = await fetch(`${API_CONFIG.serverUrl}/v1/sessions/keep-alive`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`, 
          },
          body: JSON.stringify({ session_id: sessionInfo.session_id }),
        });
        
        if (response.ok) {
             console.log(`[BotAvatar] 💓 Keep-alive SUCCESS at ${new Date().toLocaleTimeString()}`);
        } else {
             console.warn(`[BotAvatar] ⚠️ Keep-alive returned status: ${response.status}`);
        }
      } catch (error) {
        console.warn(`[BotAvatar] ⚠️ Keep-alive failed: ${error.message}`);
      }
    }
  }
})();
