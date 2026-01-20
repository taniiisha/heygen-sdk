// MainController.js
// This controller manages the overall page state, like the connection status and the list of questions.
(function () {
  "use strict";

  angular.module("AvatarPocApp").controller("MainController", MainController);

  // Inject necessary AngularJS services
  MainController.$inject = ["$scope", "$timeout"];

  function MainController($scope, $timeout) {
    var vm = this;

    // --- PROPERTIES ---
    vm.testPrompts = [
      "Can you walk me through a complex technical project you worked on recently? Describe the problem, the solution you implemented, and any challenges you encountered during the process.",
      "Explain a situation where you had to quickly learn a new technology or framework to complete a task. How did you approach the learning process and what was the outcome?",
      "Describe a time when you identified a performance bottleneck in a system or application. What tools or methods did you use to diagnose the issue, and how did you resolve it?",
      "Have you ever faced a technical disagreement with a teammate or manager? How did you handle the situation, and what was the resolution?",
      "Tell me about a time when you had to refactor or rewrite legacy code. What were the risks involved, and how did you ensure stability and improvement in the codebase?",
    ];
    var defaultPrompt =
      "Hello, I am an AI interview assistant. When you are ready, click 'Ask Next Question' to begin.";

    // --- STATE MANAGEMENT ---
    function setDefaultState() {
      vm.isConnected = false;
      vm.avatarStatus = "Disconnected.";
      vm.promptText = "";
      vm.apiKey = "";
      vm.textForAvatar = "";
      vm.currentPromptIndex = 0;
    }

    function initializeSession() {
      vm.isConnected = true;
      vm.avatarStatus = "Initializing...";
      vm.currentPromptIndex = 0;
      // Set the first prompt in the textbox right away.
      vm.promptText = vm.testPrompts[vm.currentPromptIndex];

      // Use $timeout to safely trigger the initial greeting after the view has rendered.
      $timeout(function () {
        vm.textForAvatar = defaultPrompt;
      }, 300); // Delay matches CSS transition
    }

    // --- PUBLIC METHODS ---
    vm.connect = function () {
      initializeSession();
    };

    // This simply toggles the state. The component's $onDestroy handles the actual cleanup.
    vm.disconnect = function () {
      setDefaultState();
    };

    vm.speak = function () {
      if (vm.promptText) {
        // Send the current text from the input box to the avatar
        vm.textForAvatar = vm.promptText;

        // Immediately prepare the *next* prompt and put it in the input box
        vm.currentPromptIndex =
          (vm.currentPromptIndex + 1) % vm.testPrompts.length;
        vm.promptText = vm.testPrompts[vm.currentPromptIndex];
      }
    };

    // --- EVENT HANDLERS from Component ---
    vm.handleStart = function () {
      $scope.$applyAsync(function () {
        vm.avatarStatus = "Speaking... 🗣️";
      });
    };

    vm.handleStatusChange = function (status) {
      $scope.$applyAsync(function () {
        // This updates the bold "Status:" text on your screen
        vm.avatarStatus = status;
      });
    };

    vm.handleStop = function () {
      $scope.$applyAsync(function () {
        vm.avatarStatus = "listening";
      });
    };

    vm.handleSessionError = function (errorMessage) {
      console.error("Session error from component:", errorMessage);
      $scope.$applyAsync(function () {
        setDefaultState();
        vm.avatarStatus = errorMessage || "Error: Connection lost.";
      });
    };

    // --- INITIALIZATION ---
    setDefaultState(); // Start in the disconnected state
  }
})();
