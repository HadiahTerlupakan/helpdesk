// Import konfigurasi dari config.js
import config from '../config.js';

// --- Logging Wrapper ---
// Simpan referensi ke metode console asli
const originalConsole = { ...console };
// Ambil pengaturan logging dari config, default true jika tidak ada
const enableLogs = config.enableConsoleLogs !== undefined ? config.enableConsoleLogs : true;

// Buat objek console baru yang membungkus metode console asli
const wrappedConsole = {};
['log', 'warn', 'error', 'info', 'debug', 'trace'].forEach(methodName => {
    wrappedConsole[methodName] = function(...args) {
        if (enableLogs && originalConsole[methodName]) {
            // Panggil metode console asli dengan konteks (this) yang benar dan argumen
            originalConsole[methodName].apply(console, args);
        }
    };
});

// Ganti objek console global dengan objek wrapper
// HATI-HATI: Pendekatan ini mungkin mempengaruhi beberapa library pihak ketiga.
// Alternatif yang lebih aman adalah dengan menggunakan `wrappedConsole.log` dll.
// secara eksplisit di setiap panggilan log dalam kode Anda.
// Untuk permintaan ini, kita akan menimpa objek global.
window.console = wrappedConsole;

console.log('[APP] Logging aktif:', enableLogs); // Ini akan menggunakan console wrapper
console.log('[APP] Versi aplikasi:', config.version); // Mengakses versi dari config


// --- Socket.IO Setup ---
// Tambahkan transport 'websocket' secara eksplisit jika perlu (tergantung setup server)
// const socket = io({ transports: ['websocket', 'polling'] });
const socket = io({
     reconnection: true,
     reconnectionAttempts: Infinity,
     reconnectionDelay: 1000,
     reconnectionDelayMax: 5000,
     randomizationFactor: 0.5
 });
 
 
 // --- UI Elements ---
 const loginContainer = document.getElementById('login-container');
 const appContainer = document.getElementById('app-container');
 const usernameInput = document.getElementById('username-input');
 const passwordInput = document.getElementById('password-input');
 const loginButton = document.getElementById('login-button');
 const loginError = document.getElementById('login-error');
 // QR Modal elements
 const qrModal = document.getElementById('qrModal'); // The new modal overlay
 const qrCodeDiv = qrModal.querySelector('#qr-code'); // Select QR div INSIDE the modal
 const qrStatus = qrModal.querySelector('#qr-status'); // Select status p INSIDE the modal
 const whatsappStatusDiv = document.getElementById('whatsapp-status'); // WA Status Display (stays in sidebar header)
 
 
 const adminUsernameDisplay = document.getElementById('admin-username-display');
 const adminRoleDisplay = document.getElementById('admin-role-display'); // Role Display
 const logoutButton = document.getElementById('logout-button');
 const chatList = document.getElementById('chat-list');
 const messagesDiv = document.getElementById('messages');
 const replyInput = document.getElementById('reply-input'); // Now a textarea
 const replyButton = document.getElementById('reply-button');
 const replyBox = document.getElementById('reply-box');
 const sendErrorSpan = replyBox.querySelector('.send-error-span'); // Get the error span
 
 const currentChatInfoDiv = document.getElementById('current-chat-info'); // Container for name & status
 const currentChatIdDisplay = document.getElementById('current-chat-id-display');
 const currentChatStatusSpan = document.getElementById('current-chat-status'); // Chat status span
 const chatPickedStatus = document.getElementById('chat-picked-status'); // Picked status text
 
 const chatActionsArea = document.getElementById('chat-actions-area'); // Container for actions
 const pickChatButton = document.getElementById('pick-chat-button');
 const releaseChatButton = document.getElementById('release-chat-button'); // New Release button
 const delegateChatContainer = document.getElementById('delegate-chat-container');
 const delegateChatSelect = document.getElementById('delegate-chat-select');
 const delegateChatButton = document.getElementById('delegate-chat-button');
 const closeChatButton = document.getElementById('close-chat-button'); // Close chat button
 const openChatButton = document.getElementById('open-chat-button'); // Open chat button
 
 const superadminPanel = document.getElementById('superadmin-panel'); // Super Admin Panel
 const addAdminButton = document.getElementById('add-admin-button'); // Add Admin Button
 const deleteAdminButton = document.getElementById('delete-admin-button'); // New Delete Admin Button
 const deleteAllChatsButton = document.getElementById('delete-all-chats-button'); // Delete All Chats Button
 const showQrButton = document.getElementById('show-qr-button'); // NEW Show QR Button
 const deleteChatButton = document.getElementById('delete-chat-button'); // Delete Single Chat Button
 // NEW: Quick Reply Management Elements
 const manageQuickRepliesButton = document.getElementById('manage-quick-replies-button');
 const quickReplyManagementModal = document.getElementById('quickReplyManagementModal');
 const quickReplyListUl = document.getElementById('quickReplyList');
 const qrEditIdInput = document.getElementById('qr-edit-id');
 const qrShortcutInput = document.getElementById('qr-shortcut-input');
 const qrTextInput = document.getElementById('qr-text-input');
 const submitQrButton = document.getElementById('submit-qr-button');
 const cancelEditQrButton = document.getElementById('cancel-edit-qr-button');
 const addNewQrButton = document.getElementById('add-new-qr-button');
 const qrFormStatusDiv = quickReplyManagementModal.querySelector('.qr-form-status');
 // NEW: Quick Reply Suggestions Elements (in reply box)
 const quickReplySuggestionsUl = replyBox.querySelector('.quick-reply-suggestions');
 
 
 const mediaButton = document.getElementById('media-button');
 const mediaInput = document.createElement('input'); // File input for media upload
 mediaInput.type = 'file';
 // Allow common image, video, audio, and PDF files, plus common office documents
 mediaInput.accept = 'image/*,video/*,audio/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain'; // Added text/plain
 mediaInput.style.display = 'none'; // Hide the input
 document.body.appendChild(mediaInput);
 
 const mediaPreviewContainer = document.getElementById('media-preview-container'); // Container for preview
 let selectedMedia = null; // State variable to hold selected media file data
 
 // Media Modal Elements
 const mediaModal = document.getElementById('mediaModal');
 const closeModal = document.getElementById('closeModal');
 const modalMediaContent = document.getElementById('modalMediaContent'); // Image
 const modalVideoContent = document.getElementById('modalVideoContent'); // Video
 const modalAudioContent = document.getElementById('modalAudioContent'); // Audio
 const modalDocumentContent = document.getElementById('modalDocumentContent'); // Document
 const modalDocumentName = document.getElementById('modalDocumentName');
 const modalDocumentLink = document.getElementById('modalDocumentLink');
 
 // Modal for Offline Admin Notification
 const offlineAdminModal = document.getElementById('offlineAdminModal');
 const offlineAdminMessage = document.getElementById('offlineAdminMessage');
 const offlineAdminModalClose = document.getElementById('offlineAdminModalClose');
 
 // Modal for Add Admin
 const addAdminModal = document.getElementById('addAdminModal');
 const newAdminUsernameInput = document.getElementById('new-admin-username');
 const newAdminPasswordInput = document.getElementById('new-admin-password');
 const newAdminInitialsInput = document.getElementById('new-admin-initials');
 const newAdminRoleSelect = document.getElementById('new-admin-role');
 const submitAddAdminButton = document.getElementById('submit-add-admin');
 const addAdminFormStatusDiv = addAdminModal.querySelector('.add-admin-form-status');
 
 // Modal for Delete Admin
 const deleteAdminModal = document.getElementById('deleteAdminModal'); // New Delete Admin Modal
 const deleteAdminSelect = document.getElementById('delete-admin-select'); // New Delete Admin Select
 const submitDeleteAdminButton = document.getElementById('submit-delete-admin'); // New Delete Admin Submit Button
 const deleteAdminFormStatusDiv = deleteAdminModal.querySelector('.delete-admin-form-status'); // New Delete Admin Status Div
 
 // --- Application State ---
 let currentChatId = null; // ID Chat yang sedang dibuka
 let currentUser = null; // Username admin yang login
 let currentUserRole = null; // Role admin yang login (admin/superadmin)
 let chatHistory = {}; // { chatId: { status: 'open'|'closed', messages: [...] } } - Mirror server history state
 let chatListItems = {}; // { chatId: liElement } - Reference to DOM elements
 let pickedChatsStatus = {}; // { chatId: adminUsername } - Mirror server pick state (updated via socket)
 let registeredAdmins = {}; // { username: { initials, role } } - List of all registered admins (updated via socket)
 let onlineAdmins = []; // Array of online admin usernames (updated via socket)
 let currentQrCode = null; // State variable to hold the last received QR code data
 let currentQrStatus = 'Memuat status WA...'; // State variable for QR/WA status text
 let quickReplyTemplates = []; // NEW: State variable for quick reply templates [{ id, shortcut, text }]
 let selectedSuggestionIndex = -1; // NEW: For keyboard navigation in suggestions
 
 
 // Track offline admin notifications to avoid repeated alerts for the same admin
 const offlineAdminNotified = new Set();
 
 // --- Helper Functions ---
 
 // Function to get CSS Variable value
 /**
  * Mendapatkan nilai CSS variable dari root element.
  * @function getCssVariable
  * @param {string} name - Nama CSS variable
  * @returns {string} - Nilai CSS variable
  */
 function getCssVariable(name) {
     // Get the computed style of the root element
     return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
 }
 
 // Helper to show alerts from server events (Super Admin actions, etc.)
 /**
  * Menampilkan alert dari server (untuk aksi Super Admin).
  * @function showServerAlert
  * @param {string} message - Pesan yang akan ditampilkan
  * @param {boolean} [isSuccess=true] - Flag untuk menentukan jenis alert (success/error)
  * @returns {void}
  */
 function showServerAlert(message, isSuccess = true) {
     const alertDiv = document.createElement('div');
     alertDiv.className = `server-alert ${isSuccess ? 'success' : 'error'}`;
     alertDiv.textContent = message;
 
     document.body.appendChild(alertDiv);
 
     setTimeout(() => {
         alertDiv.style.opacity = 0;
         setTimeout(() => alertDiv.remove(), 500); // Remove after fade out matches transition
     }, 5000); // Show for 5 seconds
 }
 
 
 /**
  * Menampilkan pesan error pada form login.
  * @function showLoginError
  * @param {string} message - Pesan error
  * @returns {void}
  */
 function showLoginError(message) {
     loginError.textContent = message;
     // Use getCssVariable to get the color value from CSS
     if (message.toLowerCase().includes('berhasil') || message.toLowerCase().includes('menghubungkan kembali')) {
         loginError.style.color = getCssVariable('--light-green');
     } else if (message.toLowerCase().includes('memproses')) {
         loginError.style.color = getCssVariable('--text-dark');
     } else {
         loginError.style.color = getCssVariable('--error-color');
     }
 }
 
 /**
  * Memperbarui status koneksi WhatsApp di UI.
  * @function updateWhatsappStatus
  * @param {string} statusText - Teks status
  * @param {boolean} isConnected - Flag status koneksi
  * @returns {void}
  */
 function updateWhatsappStatus(statusText, isConnected) {
     currentQrStatus = statusText; // Update internal status variable
     whatsappStatusDiv.textContent = `Status WA: ${statusText}`; // Update sidebar display
     whatsappStatusDiv.style.color = isConnected ? '#a0ffa0' : '#ffb0b0'; // Light green for connected, light red for disconnected
 
     // Also update the status text in the QR modal if it's open
     if (qrModal.style.display !== 'none') {
         qrStatus.textContent = statusText;
     }
 
     // If WA is disconnected and requires QR (or fatal error), update QR modal content (Super Admin only)
     // This is handled by specific WA event handlers below.
 }
 
 
 /**
  * Mengatur state login dan menyesuaikan UI.
  * @function setLoginState
  * @param {boolean} isLoggedIn - Flag status login
  * @param {string|null} [username=null] - Username admin
  * @param {string|null} [role=null] - Role admin
  * @param {Object} [initialPicks={}] - Objek berisi chat yang sudah diambil
  * @returns {void}
  */
 function setLoginState(isLoggedIn, username = null, role = null, initialPicks = {}) {
     if (isLoggedIn) {
         currentUser = username;
         currentUserRole = role; // Store the role
         localStorage.setItem('loggedInUsername', username);
         // localStorage.setItem('currentUserRole', role); // Optional: store role
         adminUsernameDisplay.textContent = `Admin: ${username}`;
         adminRoleDisplay.textContent = `Role: ${role === 'superadmin' ? 'Super Admin' : 'Admin Biasa'}`; // Display role
         pickedChatsStatus = initialPicks || {}; // Set initial picks received
         loginContainer.classList.add('hidden');
         appContainer.classList.remove('hidden'); // Show app container
         console.log(`[UI] Login state set: Logged in as ${username} with role ${role}.`);
         showLoginError(''); // Clear any previous login messages
         requestNotificationPermission();
         // Show/hide Super Admin panel based on role
         superadminPanel.style.display = (currentUserRole === 'superadmin') ? 'flex' : 'none';
 
         // Ensure QR button and Quick Reply Manage button is shown only for Super Admin
         if (currentUserRole === 'superadmin') {
             showQrButton.style.display = 'flex'; // Use flex for icon alignment
             manageQuickRepliesButton.style.display = 'flex'; // Use flex for icon alignment
         } else {
             showQrButton.style.display = 'none';
             manageQuickRepliesButton.style.display = 'none';
         }
 
         // Request initial data will be handled by the server logic on successful login/reconnect (via 'request_initial_data' emission)
 
         // On successful login/reconnect, clear any old QR display
         currentQrCode = null; // Clear stored QR data
         qrCodeDiv.innerHTML = ''; // Clear QR code display in the modal
         // qrStatus text will be updated by updateWhatsappStatus
         qrModal.style.display = 'none'; // Ensure QR modal is hidden
 
     } else {
         currentUser = null;
         currentUserRole = null; // Clear role on logout
         localStorage.removeItem('loggedInUsername'); // Clear username
         // localStorage.removeItem('currentUserRole', role); // Optional
         loginContainer.classList.remove('hidden'); // Show login container
         appContainer.classList.add('hidden'); // Hide app container
         resetUI(); // Reset all UI and state
         usernameInput.value = '';
         passwordInput.value = '';
         console.log('[UI] Login state set: Logged out.');
         showLoginError('Silakan login kembali.');
         updateWhatsappStatus('Disconnected', false); // Assume disconnected on logout
         superadminPanel.style.display = 'none'; // Hide Super Admin panel
         showQrButton.style.display = 'none'; // Hide QR button on logout
         manageQuickRepliesButton.style.display = 'none'; // Hide Quick Reply Manage button on logout
 
         // Hide and clear QR modal explicitly on logout
         qrModal.style.display = 'none';
         qrCodeDiv.innerHTML = '';
         qrStatus.textContent = '';
         currentQrCode = null;
         currentQrStatus = 'Memuat status WA...'; // Reset status
         // Hide quick reply suggestions on logout
         hideQuickReplySuggestions();
     }
 }
 
 /**
  * Meminta izin notifikasi dari pengguna.
  * @function requestNotificationPermission
  * @returns {void}
  */
 function requestNotificationPermission() {
     // Check if the browser supports Notifications
     if ('Notification' in window) {
         // Check if permission is already granted or denied
         if (Notification.permission !== "granted" && Notification.permission !== 'denied') {
             // Request permission from the user
             Notification.requestPermission().then(permission => {
                 console.log(`Notification permission: ${permission}`);
             });
         }
     } else {
         console.warn("Browser does not support Notifications.");
     }
 }
 
 /**
  * Menampilkan notifikasi browser.
  * @function showNotification
  * @param {string} title - Judul notifikasi
  * @param {string} body - Isi notifikasi
  * @param {Object} [options={}] - Opsi tambahan untuk notifikasi
  * @returns {void}
  */
 function showNotification(title, body, options = {}) {
     // Check if browser supports notifications AND permission is granted
     if ('Notification' in window && Notification.permission === "granted") {
         // Prevent notification if chat is currently active and picked by this user
         // This requires currentChatId, pickedChatsStatus, and currentUser to be correct.
         if (currentChatId === options.chatId && pickedChatsStatus[currentChatId] === currentUser) {
             console.log(`Notification suppressed for active chat ${options.chatId}`);
             return; // Do not show notification
         }
 
         try {
             const notification = new Notification(title, {
                 body: body,
                 icon: options.icon || '/favicon.ico',
                 tag: options.chatId // Use chat ID as tag to update existing notifications for the same chat
             });
 
             // Add click handler to focus the window and navigate to the chat
             notification.onclick = function(event) {
                 event.preventDefault(); // Prevent the browser from focusing the tab that opened the notification
                 if (options.chatId) {
                     // Find the chat list item and trigger its click event
                     const listItem = chatListItems[options.chatId];
                     if (listItem) {
                         listItem.click(); // This will switch the active chat
                     }
                 }
                 window.focus(); // Bring the window to front
             };
         } catch (e) {
             console.error("Failed to create notification:", e);
         }
     }
 }
 
 /**
  * Mereset area chat ke keadaan awal.
  * @function resetChatArea
  * @returns {void}
  */
 function resetChatArea() {
     messagesDiv.innerHTML = '<div class="placeholder">Pilih percakapan dari daftar</div>';
     currentChatIdDisplay.textContent = 'Pilih percakapan dari daftar';
     currentChatStatusSpan.style.display = 'none'; // Hide status
     currentChatStatusSpan.textContent = '';
     currentChatStatusSpan.className = ''; // Clear status class
     chatPickedStatus.textContent = ''; // Clear picked status text
 
     pickChatButton.style.display = 'none';
     releaseChatButton.style.display = 'none'; // Hide Release button
     delegateChatContainer.style.display = 'none';
     delegateChatSelect.innerHTML = '<option value="" disabled selected>Pilih Admin</option>'; // Reset delegate select
 
     // Disable reply box and media button
     replyBox.classList.add('disabled');
     replyInput.disabled = true;
     replyButton.disabled = true;
     mediaButton.disabled = true;
 
     closeChatButton.style.display = 'none'; // Hide close/open buttons
     openChatButton.style.display = 'none';
     deleteChatButton.style.display = 'none'; // Controlled by SuperAdmin role later
 
     replyInput.value = ''; // Clear input value
     selectedMedia = null; // Clear selected media state
     updateMediaPreview(); // Hide media preview
     replyInput.placeholder = 'Pilih atau ambil chat untuk membalas...';
     document.title = 'WhatsApp Helpdesk';
     hideSendError(); // Hide any send error message
     // Reset textarea height
     replyInput.style.height = 'auto';
     replyInput.rows = 1; // Reset rows attribute as well
     // Hide quick reply suggestions
     hideQuickReplySuggestions();
 }
 
 /**
  * Mereset seluruh UI ke keadaan awal.
  * @function resetUI
  * @returns {void}
  */
 function resetUI() {
     resetChatArea();
     // Clear chat list and its internal state
     chatList.innerHTML = '<div class="placeholder" style="color: rgba(255,255,255,0.7); text-align: center; margin-top: 20px;">Memuat percakapan...</div>'; // Reset chat list placeholder
     chatHistory = {};
     chatListItems = {};
     pickedChatsStatus = {}; // Crucially reset picked status
     registeredAdmins = {}; // Clear registered admins
     onlineAdmins = []; // Clear online admins
     currentChatId = null;
     currentUser = null;
     currentUserRole = null; // Clear role
     adminUsernameDisplay.textContent = '';
     adminRoleDisplay.textContent = ''; // Clear role display
     updateWhatsappStatus('Memuat status WA...', false); // Reset WA Status display
 
     showLoginError(''); // Clear login error specifically
     superadminPanel.style.display = 'none'; // Hide Super Admin panel
     showQrButton.style.display = 'none'; // Hide QR button
     manageQuickRepliesButton.style.display = 'none'; // Hide Quick Reply Manage button
     quickReplyTemplates = []; // Clear quick reply templates
 
     // Hide and clear QR modal on full UI reset
     qrModal.style.display = 'none';
     qrCodeDiv.innerHTML = '';
     qrStatus.textContent = '';
     currentQrCode = null;
     currentQrStatus = 'Memuat status WA...'; // Reset stored status
     // Hide quick reply suggestions on reset
     hideQuickReplySuggestions();
 }
 
 // --- Helper Functions ---
 
 // Moved function declaration to a scope where it's available
 /**
  * Memperbarui status pick untuk semua item chat list.
  * @function updateAllChatListItemsPickStatus
  * @returns {void}
  */
 function updateAllChatListItemsPickStatus() {
     console.log('[UI] Memperbarui status pick semua chat item.');
     // Use Object.keys(chatListItems) to iterate over currently rendered items
     Object.keys(chatListItems).forEach(chatId => {
         updateChatListItemPickStatus(chatId);
         updateUnreadIndicator(chatId); // Also ensure unread is correct
     });
 }
 
 
 function updateChatAreaForCurrentChat() {
     if (!currentChatId || !currentUser) {
         resetChatArea();
         return;
     }
 
     // Find the chat name and status from the chatHistory state
     const chatEntry = chatHistory[currentChatId]; // Get the chat entry from state
     // Fallback to chat ID if chatListItems not ready or entry missing
     const chatName = chatListItems[currentChatId] ? chatListItems[currentChatId].dataset.chatName : currentChatId.split('@')[0];
     const chatStatus = chatEntry?.status || 'open'; // Get status, default to 'open'
 
     const pickedBy = pickedChatsStatus[currentChatId];
 
     currentChatIdDisplay.textContent = `Chat: ${chatName}`;
     document.title = `Chat: ${chatName}`;
 
     // Update chat status display in header
     currentChatStatusSpan.style.display = 'inline-block'; // Use inline-block
     currentChatStatusSpan.textContent = chatStatus.toUpperCase();
     currentChatStatusSpan.className = `current-chat-status ${chatStatus}`; // Add class for styling
 
     // Update picked status display in header
     chatPickedStatus.textContent = pickedBy ? `Diambil oleh: ${pickedBy}` : 'Belum diambil';
     chatPickedStatus.style.color = getCssVariable('--text-muted'); // Reset error color
 
     hideSendError(); // Hide send error when switching chats
 
     // Enable/Disable reply box and media button based on chat status AND pick status
     const canReply = chatStatus === 'open' && pickedBy === currentUser;
     if (canReply) {
         replyBox.classList.remove('disabled');
         replyInput.disabled = false;
         replyButton.disabled = false;
         mediaButton.disabled = false;
         replyInput.placeholder = 'Ketik balasan atau ketik "/" untuk balas cepat...'; // Updated placeholder
         // Auto-size textarea on load for current chat
         replyInput.style.height = 'auto';
         replyInput.rows = 1; // Reset rows before calculating scrollHeight
         // Use a slight delay to ensure element is fully rendered before calculating scrollHeight
         setTimeout(() => {
             replyInput.style.height = replyInput.scrollHeight + 'px';
         }, 0);
 
         setTimeout(() => replyInput.focus(), 100); // Auto-focus
     } else {
         replyBox.classList.add('disabled');
         replyInput.disabled = true;
         replyButton.disabled = true;
         mediaButton.disabled = true;
         if (chatStatus === 'closed') {
             replyInput.placeholder = 'Percakapan ditutup. Tidak bisa membalas.';
         } else if (pickedBy) {
             replyInput.placeholder = `Ditangani oleh ${pickedBy}. Anda tidak bisa membalas kecuali mengambil alih.`;
         } else {
             replyInput.placeholder = 'Ambil chat ini untuk membalas.';
         }
         replyInput.value = ''; // Clear input value when disabling
         selectedMedia = null; // Clear media when disabling
         updateMediaPreview(); // Hide media preview
         // Reset textarea height when disabling
         replyInput.style.height = 'auto';
         replyInput.rows = 1;
         // Hide quick reply suggestions if reply box is disabled
         hideQuickReplySuggestions();
     }
 
 
     // Show/Hide action buttons based on pick status, chat status, and user role
     // Default hide all action buttons
     pickChatButton.style.display = 'none';
     releaseChatButton.style.display = 'none'; // Ensure hidden by default
     delegateChatContainer.style.display = 'none';
     closeChatButton.style.display = 'none';
     openChatButton.style.display = 'none';
     deleteChatButton.style.display = 'none'; // Controlled by SuperAdmin role later
 
     if (chatStatus === 'open') {
         // Show Pick button if not picked AND user is not Super Admin (Super Admin doesn't need to pick to delegate/reply)
         if (!pickedBy && currentUserRole !== 'superadmin') {
             pickChatButton.style.display = 'inline-block';
             pickChatButton.disabled = false; // Ensure pick button is enabled when shown
             pickChatButton.textContent = 'Ambil Chat Ini'; // Reset text
         }
         // Show Release button if picked by the current user
         if (pickedBy === currentUser) { // Correct condition
             releaseChatButton.style.display = 'inline-block';
             releaseChatButton.disabled = false; // Ensure release button is enabled when shown
             releaseChatButton.textContent = 'Lepas Chat'; // Reset text
         }
 
         // Show Delegate container if picked by current user OR is Super Admin
         if (pickedBy === currentUser || currentUserRole === 'superadmin') {
             delegateChatContainer.style.display = 'flex'; // Use flex as container uses flex
             delegateChatButton.disabled = false; // Ensure delegate button is enabled
             delegateChatSelect.disabled = false; // Ensure select is enabled
             populateDelegateChatSelect(); // Populate select when container is shown
         }
         // Show Close button if Super Admin OR if admin who picked it (backend allows this)
         if (currentUserRole === 'superadmin' || pickedBy === currentUser) {
             closeChatButton.style.display = 'inline-block';
             closeChatButton.disabled = false; // Ensure button is enabled
         }
 
 
     } else { // ChatStatus is 'closed'
         // Only Superadmin can open closed chats
         if (currentUserRole === 'superadmin') {
             openChatButton.style.display = 'inline-block';
             openChatButton.disabled = false; // Ensure button is enabled
         }
     }
 
     // Show/Hide Delete Chat button based on Super Admin role
     deleteChatButton.style.display = (currentUserRole === 'superadmin') ? 'inline-block' : 'none';
     deleteChatButton.disabled = false; // Ensure button is enabled when shown
 
 }
 
 function populateDelegateChatSelect() {
     console.log('[Delegate Select] Populating select. Current User:', currentUser);
     // Clear existing options except the disabled default
     delegateChatSelect.innerHTML = '<option value="" disabled selected>Pilih Admin</option>';
 
     const onlineAdminsSet = new Set(onlineAdmins || []); // Use the state variable
     // Ensure registeredAdmins is loaded
     if (!registeredAdmins || Object.keys(registeredAdmins).length === 0) {
         console.warn('[Delegate Select] registeredAdmins data not available yet.');
         return;
     }
 
     const sortedAdminUsernames = Object.keys(registeredAdmins).sort();
 
     sortedAdminUsernames.forEach(admin => {
         // Don't show current user in delegate list
         if (admin === currentUser) return;
 
         const isOnline = onlineAdminsSet.has(admin);
         const option = document.createElement('option');
         option.value = admin;
         option.textContent = `${admin} ${isOnline ? '(Online)' : '(Offline)'}`;
         option.className = isOnline ? 'online' : 'offline';
         // Optionally disable delegation to offline admins if desired, but backend doesn't currently enforce this.
         // option.disabled = !isOnline;
         delegateChatSelect.appendChild(option);
     });
     // Reset selected option to the placeholder after populating
     delegateChatSelect.value = ""; // Select the disabled option
     console.log('[Delegate Select] Select populated.');
 }
 
 // Function to populate the Delete Admin select dropdown AND manage submit button disabled state
 function populateDeleteAdminSelect() {
     console.log('[Delete Admin Select] Populating select. Current User:', currentUser);
     deleteAdminSelect.innerHTML = '<option value="" disabled selected>Pilih Admin</option>';
 
     // Clear status message initially
     deleteAdminFormStatusDiv.textContent = '';
     deleteAdminFormStatusDiv.className = 'delete-admin-form-status';
 
     if (!registeredAdmins || Object.keys(registeredAdmins).length === 0) {
         console.warn('[Delete Admin Select] registeredAdmins data not available yet or is empty.');
          const noAdminOption = document.createElement('option');
          noAdminOption.value = '';
          noAdminOption.textContent = 'Tidak ada admin lain';
          noAdminOption.disabled = true;
          deleteAdminSelect.appendChild(noAdminOption);
          submitDeleteAdminButton.disabled = true; // Explicitly disable if no admins at all
          deleteAdminFormStatusDiv.textContent = 'Tidak ada admin lain yang bisa dihapus.'; // Add status message
          deleteAdminFormStatusDiv.className = 'delete-admin-form-status info'; // Add info class for visual cue
          console.log('[Delete Admin Select] No registered admins found. Submit button disabled.');
         return;
     }
 
     const sortedAdminUsernames = Object.keys(registeredAdmins).sort();
 
     let hasOtherAdmins = false;
     sortedAdminUsernames.forEach(admin => {
         // Exclude the current user from the delete list
         if (admin === currentUser) {
              console.log(`[Delete Admin Select] Excluding current user: ${admin}`);
              return;
         }
 
         hasOtherAdmins = true; // Found at least one other admin
         console.log(`[Delete Admin Select] Adding admin to select: ${admin}`);
 
         const option = document.createElement('option');
         option.value = admin;
         option.textContent = admin;
         deleteAdminSelect.appendChild(option);
     });
 
     if (!hasOtherAdmins) {
         const noAdminOption = document.createElement('option');
         noAdminOption.value = '';
         noAdminOption.textContent = 'Tidak ada admin lain';
         noAdminOption.disabled = true;
         deleteAdminSelect.appendChild(noAdminOption);
         deleteAdminFormStatusDiv.textContent = 'Tidak ada admin lain yang bisa dihapus.'; // Add status message
         deleteAdminFormStatusDiv.className = 'delete-admin-form-status info'; // Add info class
     }
 
     // Reset selected option to the placeholder
     deleteAdminSelect.value = "";
     // Disable submit button if no other admins to delete
     submitDeleteAdminButton.disabled = !hasOtherAdmins;
     console.log(`[Delete Admin Select] Submit button disabled state set to: ${!hasOtherAdmins}. hasOtherAdmins: ${hasOtherAdmins}`);
 }
 
 // NEW: Function to populate the Quick Reply management list
 function populateQuickReplyManagementList() {
     quickReplyListUl.innerHTML = ''; // Clear existing list
 
     // --- FIX: Ensure quickReplyTemplates is an array before iterating ---
     if (!Array.isArray(quickReplyTemplates) || quickReplyTemplates.length === 0) {
         quickReplyListUl.innerHTML = '<li>Belum ada template balas cepat.</li>';
         return;
     }
     // --- END FIX ---
 
     quickReplyTemplates.forEach(template => {
         const li = document.createElement('li');
         li.dataset.id = template.id;
         li.innerHTML = `
                    <span class="qr-shortcut">${sanitizeHTML(template.shortcut)}</span> <!-- Display /shortcut -->
                    <span class="qr-text">${sanitizeHTML(template.text)}</span>
                    <span class="qr-actions">
                        <button class="edit-qr" data-id="${template.id}"><i class="fas fa-edit"></i> Edit</button>
                        <button class="delete-qr" data-id="${template.id}"><i class="fas fa-trash"></i> Hapus</button>
                    </span>
                 `;
         quickReplyListUl.appendChild(li);
     });
     // Add event listeners to edit and delete buttons
     quickReplyListUl.querySelectorAll('.edit-qr').forEach(button => {
         button.addEventListener('click', handleEditQuickReplyClick);
     });
     quickReplyListUl.querySelectorAll('.delete-qr').forEach(button => {
         button.addEventListener('click', handleDeleteQuickReplyClick);
     });
 }
 
 // NEW: Function to handle Edit button click in QR management modal
 function handleEditQuickReplyClick(event) {
     const templateId = event.target.dataset.id;
     // --- FIX: Ensure quickReplyTemplates is an array before calling find ---
     const templateToEdit = Array.isArray(quickReplyTemplates) ? quickReplyTemplates.find(t => t.id === templateId) : null;
     // --- END FIX ---
 
     if (templateToEdit) {
         qrEditIdInput.value = templateToEdit.id;
         qrShortcutInput.value = templateToEdit.shortcut;
         qrTextInput.value = templateToEdit.text;
 
         // Change form state to 'editing'
         submitQrButton.textContent = 'Update Template';
         submitQrButton.classList.remove('add-new');
         submitQrButton.classList.add('update-existing');
         cancelEditQrButton.style.display = 'inline-block';
         addNewQrButton.style.display = 'none'; // Hide "Add New" button
 
         qrFormStatusDiv.textContent = 'Mengedit template...';
         qrFormStatusDiv.className = 'qr-form-status'; // Reset status class
 
         // Focus the shortcut input
         qrShortcutInput.focus();
     }
 }
 
 // NEW: Function to handle Cancel Edit button click
 cancelEditQrButton.addEventListener('click', (event) => {
     event.preventDefault(); // Prevent form submission if it were inside a form
     resetQuickReplyForm();
 });
 
 // NEW: Function to handle Add New button click in QR management modal
 if (addNewQrButton) {
     addNewQrButton.addEventListener('click', (event) => {
         event.preventDefault(); // Prevent form submission
         resetQuickReplyForm();
         qrShortcutInput.focus(); // Focus shortcut input for new entry
     });
 }
 
 
 // NEW: Function to reset the QR management form
 function resetQuickReplyForm() {
     qrEditIdInput.value = '';
     qrShortcutInput.value = '';
     qrTextInput.value = '';
 
     submitQrButton.textContent = 'Simpan Template';
     submitQrButton.classList.remove('update-existing');
     submitQrButton.classList.add('add-new'); // Optional: Add class for styling if needed
     if (cancelEditQrButton) cancelEditQrButton.style.display = 'none';
     if (addNewQrButton) addNewQrButton.style.display = 'inline-block'; // Show "Add New" button
 
     if (qrFormStatusDiv) {
         qrFormStatusDiv.textContent = ''; // Clear status
         qrFormStatusDiv.className = 'qr-form-status'; // Reset status class
     }
 }
 
 // NEW: Function to handle Delete button click in QR management modal
 function handleDeleteQuickReplyClick(event) {
     const templateId = event.target.dataset.id;
     // --- FIX: Ensure quickReplyTemplates is an array before calling find ---
     const templateToDelete = Array.isArray(quickReplyTemplates) ? quickReplyTemplates.find(t => t.id === templateId) : null;
     // --- END FIX ---
 
     if (templateToDelete) {
         if (confirm(`Anda yakin ingin menghapus template "${sanitizeHTML(templateToDelete.shortcut)}"?`)) { // Use shortcut in confirmation
             console.log(`[UI] Super Admin ${currentUser} menghapus template QR: ${templateToDelete.shortcut}`);
             // Emit socket event to delete
             socket.emit('delete_quick_reply', {
                 id: templateId
             });
         }
     }
 }
 
 
 function updateChatListItemPickStatus(chatId) {
     const listItem = chatListItems[chatId];
     if (!listItem) {
         // console.warn("Elemen .chat-item-picked-by tidak ditemukan untuk chat:", chatId, "- List item not found.");
         return; // Chat list item might not exist yet if message is very first one
     }
 
     let statusContainer = listItem.querySelector('.message-snippet'); // Find the snippet div
     if (!statusContainer) {
         console.warn("Elemen .message-snippet tidak ditemukan untuk chat:", chatId);
         return;
     }
 
     let statusSpan = statusContainer.querySelector('.chat-item-picked-by');
     // Create the span if it doesn't exist (should be in initial template, but safety)
     if (!statusSpan) {
         statusSpan = document.createElement('span');
         statusSpan.className = 'chat-item-picked-by';
         statusContainer.appendChild(statusSpan); // Append inside the snippet div
         // console.warn("Elemen .chat-item-picked-by DIBUAT untuk chat:", chatId);
     }
 
 
     const pickedBy = pickedChatsStatus[chatId];
     // Check if the chat is currently picked by the *current* user
     const isPickedByCurrentUser = pickedBy === currentUser;
 
     if (pickedBy) {
         statusSpan.textContent = `(Oleh: ${pickedBy})`;
         statusSpan.style.display = 'inline';
         // Visual cue in list item if picked by current user
         if (isPickedByCurrentUser) {
             listItem.classList.add('picked-by-me');
         } else {
             listItem.classList.remove('picked-by-me');
         }
     } else {
         statusSpan.textContent = '';
         statusSpan.style.display = 'none';
         listItem.classList.remove('picked-by-me');
     }
     // Ensure unread indicator is updated correctly after pick status change
     updateUnreadIndicator(chatId);
 }
 
 
 function updateUnreadIndicator(chatId) {
     const listItem = chatListItems[chatId];
     if (!listItem) return;
 
     const unreadIndicator = listItem.querySelector('.unread-indicator');
     if (!unreadIndicator) return;
 
     // Check actual unread status from chatHistory state
     // A message is unread if it's incoming AND its 'unread' flag is true.
     const hasUnread = chatHistory[chatId]?.messages?.some(msg => msg.type === 'incoming' && msg.unread) || false;
 
     // Show unread indicator if there are unread messages AND the chat is NOT currently active
     const shouldShowUnread = hasUnread && chatId !== currentChatId;
 
     unreadIndicator.style.display = shouldShowUnread ? 'inline' : 'none';
 
 }
 
 function updateChatListItemStatus(chatId, status) {
     const listItem = chatListItems[chatId];
     if (!listItem) return;
 
     let statusSpan = listItem.querySelector('.chat-item-status');
     if (!statusSpan) {
         statusSpan = document.createElement('span');
         statusSpan.className = 'chat-item-status';
         listItem.appendChild(statusSpan);
     }
 
     statusSpan.textContent = status.toUpperCase();
     statusSpan.className = `chat-item-status ${status}`; // Adds 'open' or 'closed' class
 
     // Update list item class for styling
     if (status === 'closed') {
         listItem.classList.add('closed');
     } else {
         listItem.classList.remove('closed');
     }
 
     // If the currently active chat's status changes, update the header area
     if (chatId === currentChatId) {
         updateChatAreaForCurrentChat(); // This re-evaluates button/reply box states
     }
 }
 
 
 function updateChatList(chatId, name, lastMessageText = '', timestamp = new Date().toISOString(), chatStatus = 'open', isInitialLoad = false) {
     let li = chatListItems[chatId];
     const messageTimestamp = new Date(timestamp);
     // Use a formatter that handles locale and potentially date if it's not today
     const now = new Date();
     const isToday = now.toDateString() === messageTimestamp.toDateString();
     const formattedTime = !isNaN(messageTimestamp.getTime()) ?
         (isToday ? messageTimestamp.toLocaleTimeString([], {
             hour: '2-digit',
             minute: '2-digit'
         }) : messageTimestamp.toLocaleDateString()) :
         '--:--'; // Handle invalid dates
 
     const snippetText = lastMessageText?.trim() || '[Media/Kosong]';
     const shortMessage = snippetText.substring(0, 30) + (snippetText.length > 30 ? '...' : '');
 
     // Check if chat item already exists
     if (!li) {
         li = document.createElement('li');
         li.dataset.chatId = chatId;
         li.dataset.chatName = name;
         li.innerHTML = `
                   <div class="chat-info">
                       <i class="fas fa-user-circle"></i>
                       <span class="chat-name">${sanitizeHTML(name)}</span>
                       <span class="timestamp">${formattedTime}</span>
                   </div>
                   <div class="message-snippet">
                       <span class="last-message">${sanitizeHTML(shortMessage)}</span>
                       <span class="unread-indicator">(Baru)</span>
                       <span class="chat-item-picked-by"></span>
                   </div>
                    <span class="chat-item-status" style="display: none;"></span> <!-- Status will be set by updateChatListItemStatus -->
               `;
 
         // Add click listener
         li.addEventListener('click', () => {
             // Prevent clicking on the currently selected chat
             if (currentChatId === chatId) return;
 
             // Deselect previous chat item if any
             if (currentChatId && chatListItems[currentChatId]) {
                 chatListItems[currentChatId].classList.remove('selected');
             }
 
             // Set new current chat and select the list item
             currentChatId = chatId;
             li.classList.add('selected');
 
             // Mark chat as read and load messages
             markChatAsRead(chatId);
             loadChatMessages(chatId); // This will trigger 'chat_history' event
 
             // Update chat area header and actions based on the newly selected chat
             // Call this *after* loadChatMessages, because chatHistory state might be updated by the response
             // No, updateChatAreaForCurrentChat needs the *initial* state to show placeholders.
             // It will be called *again* when 'chat_history' is received.
             updateChatAreaForCurrentChat(); // Show loading/initial state buttons
 
             // Update unread indicator for the newly selected chat (should become hidden)
             updateUnreadIndicator(chatId); // This will hide the indicator
             // Hide quick reply suggestions when switching chats
             hideQuickReplySuggestions();
 
         });
 
         // Store reference to the created list item
         chatListItems[chatId] = li;
 
         // Insert the new list item into the chat list, sorted by timestamp (newest first)
         let inserted = false;
         const currentItems = Array.from(chatList.children).filter(item => item.tagName === 'LI');
         const newItemTime = messageTimestamp.getTime();
 
         for (let i = 0; i < currentItems.length; i++) {
             const existingItemId = currentItems[i].dataset.chatId;
             // Get the last message timestamp of the existing item from chatHistory state
             const existingChatEntry = chatHistory[existingItemId];
             const existingMessagesArray = existingChatEntry?.messages || [];
             const lastExistingMessage = existingMessagesArray.length > 0 ? existingMessagesArray[existingMessagesArray.length - 1] : null;
             const existingItemTime = lastExistingMessage ? new Date(lastExistingMessage.timestamp).getTime() : 0;
 
 
             if (newItemTime > existingItemTime) {
                 chatList.insertBefore(li, currentItems[i]);
                 inserted = true;
                 break;
             }
             // Continue searching, the element should be inserted *after* this one if we reach the end
             if (i === currentItems.length - 1) {
                 const insertBeforeElement = currentItems[i].nextSibling;
                 if (li !== insertBeforeElement) {
                     chatList.insertBefore(li, insertBeforeElement);
                 }
             }
         }
         // If the new item is the oldest, append it to the end
         if (!inserted) {
             chatList.appendChild(li);
         }
 
         // Remove the initial placeholder if it exists
         const initialPlaceholder = chatList.querySelector('.placeholder');
         if (initialPlaceholder) initialPlaceholder.remove();
 
 
     } else {
         // If chat item already exists, update its content
         li.querySelector('.chat-name').textContent = sanitizeHTML(name);
         li.querySelector('.last-message').textContent = sanitizeHTML(shortMessage);
         li.querySelector('.timestamp').textContent = formattedTime;
         li.dataset.chatName = name; // Update dataset in case name changed
 
         // Update pick status and unread indicator for the existing item
         updateChatListItemPickStatus(chatId);
         updateUnreadIndicator(chatId); // Re-evaluate unread status
 
         // Update the status display for the existing item
         updateChatListItemStatus(chatId, chatStatus);
 
         // If it's a new incoming message (and not during initial load), move it to the top
         if (!isInitialLoad && chatId !== currentChatId) { // Don't move if current chat or during initial load
             // Find the correct position based on the new timestamp (newest first)
             const currentItems = Array.from(chatList.children).filter(item => item.tagName === 'LI');
             let insertBeforeElement = chatList.firstChild; // Default to placing at the beginning
             const newItemTime = messageTimestamp.getTime();
 
             for (let i = 0; i < currentItems.length; i++) {
                 const existingItemId = currentItems[i].dataset.chatId;
                 const existingChatEntry = chatHistory[existingItemId];
                 const existingMessagesArray = existingChatEntry?.messages || [];
                 const lastExistingMessage = existingMessagesArray.length > 0 ? existingMessagesArray[existingMessagesArray.length - 1] : null;
                 const existingItemTime = lastExistingMessage ? new Date(lastExistingMessage.timestamp).getTime() : 0;
 
                 // If the new item is newer than or equal to the current one in the list, insert before that one
                 if (newItemTime > existingItemTime) {
                     insertBeforeElement = currentItems[i];
                     break; // Found the position
                 }
                 // Continue searching, the element should be inserted *after* this one if we reach the end
                 if (i === currentItems.length - 1) {
                     insertBeforeElement = currentItems[i].nextSibling;
                 }
             }
             // Only move if the item is not already in the correct position
             if (li !== insertBeforeElement) {
                 if (insertBeforeElement) {
                     chatList.insertBefore(li, insertBeforeElement);
                 } else {
                     chatList.appendChild(li);
                 }
             }
         }
     }
 }
 
 
 function markChatAsRead(chatId) {
     const listItem = chatListItems[chatId];
     if (listItem) {
         const unreadIndicator = listItem.querySelector('.unread-indicator');
         if (unreadIndicator) {
             unreadIndicator.style.display = 'none'; // Hide immediately in UI
         }
     }
 
     // Update state and notify server
     if (chatHistory[chatId]?.messages) {
         let changed = false;
         for (let i = chatHistory[chatId].messages.length - 1; i >= 0; i--) {
             // Only mark incoming and unread
             if (chatHistory[chatId].messages[i].type === 'incoming' && chatHistory[chatId].messages[i].unread) {
                 chatHistory[chatId].messages[i].unread = false;
                 changed = true;
             } else if (chatHistory[chatId].messages[i].type === 'outgoing') {
                 // Stop when we see an outgoing message (means admin handled it previously)
                 break;
             }
         }
         if (changed) {
             console.log(`Marking chat ${chatId} as read.`);
             socket.emit('mark_as_read', {
                 chatId
             });
         }
     }
 }
 
 function loadChatMessages(chatId) {
     // Clear messages area and show loading placeholder
     messagesDiv.innerHTML = '<div class="placeholder">Memuat pesan...</div>';
     console.log(`Requesting history for ${chatId}`);
     // Request chat history from the server
     socket.emit('get_chat_history', chatId);
 }
 
 function sanitizeHTML(str) {
     if (str === null || str === undefined) return '';
     const temp = document.createElement('div');
     temp.textContent = str; // Use textContent to escape HTML
     return temp.innerHTML.replace(/\n/g, '<br>'); // Convert newlines to <br>
 }
 
 // Helper to determine the MIME type for data URL/blob based on original type or filename
 function getMimeTypeForDisplay(mediaType, mimeType, fileName) {
     // Use the actual MIME type if available from backend
     if (mimeType) return mimeType;
 
     // Fallback based on Baileys message type or filename extension
     if (mediaType === 'imageMessage') return 'image/jpeg';
     if (mediaType === 'videoMessage') return 'video/mp4';
     if (mediaType === 'audioMessage') return 'audio/mpeg'; // Common fallback, might need specific codecs
     if (mediaType === 'stickerMessage') return 'image/webp';
 
     // Try to guess based on file extension for documents/unknowns
     if (fileName) {
         const ext = fileName.split('.').pop().toLowerCase();
         if (ext === 'pdf') return 'application/pdf';
         if (ext === 'doc' || ext === 'docx') return 'application/msword';
         if (ext === 'xls' || ext === 'xlsx') return 'application/vnd.ms-excel';
         if (ext === 'ppt' || ext === 'pptx') return 'application/vnd.ms-powerpoint';
         if (ext === 'txt') return 'text/plain';
         // Add more common types as needed
     }
 
     // Default generic type
     return 'application/octet-stream';
 }
 
 
 function appendMessage(msgData) {
     // Basic validation
     if (!msgData || !msgData.id || !msgData.type || !msgData.chatId) {
         console.error("Invalid message data received:", msgData);
         return;
     }
 
     const {
         id,
         from,
         text,
         type,
         mediaData,
         mediaType,
         mimeType,
         timestamp,
         fileName,
         initials,
         chatId
     } = msgData; // Include chatId, mimeType
 
     // Check if this message is for the currently active chat
     if (chatId !== currentChatId) {
         // console.log(`Message for chat ${chatId} received, but current chat is ${currentChatId}. Ignoring append.`);
         return; // Only append messages for the currently viewed chat
     }
 
     // Prevent adding duplicate messages to the UI
     if (messagesDiv.querySelector(`[data-message-id="${id}"]`)) {
         // console.warn(`Pesan dengan ID ${id} sudah ditampilkan, diabaikan penambahannya ke UI.`);
         return;
     }
 
     const messageDiv = document.createElement('div');
     messageDiv.className = `message ${type}`;
     messageDiv.dataset.messageId = id;
     messageDiv.dataset.timestamp = timestamp; // Store timestamp for sorting
 
 
     let contentHTML = '';
 
     // Add sender info for outgoing messages (Admin's initials)
     // Display initials and a colon for outgoing messages, including the hyphen prefix
     // Format: -[INITIALS]:
     if (type === 'outgoing' && initials) {
         contentHTML += `<strong>-${sanitizeHTML(initials)}:</strong> `;
     }
 
     // Handle media content
     if (mediaData) {
         // Determine the appropriate MIME type for displaying the data URL
         const displayMimeType = getMimeTypeForDisplay(mediaType, mimeType, fileName);
         let dataUrl = mediaData;
         // Ensure dataUrl has the correct format if it's just the base64 string
         if (!mediaData.startsWith('data:')) {
             dataUrl = `data:${displayMimeType};base64,${mediaData}`;
         }
 
         // Display media based on its general type or MIME type
         if (displayMimeType.startsWith('image/')) {
             // Use onclick to open the image in the modal
             contentHTML += `<img src="${dataUrl}" alt="Media Gambar" style="cursor: pointer;" onclick="openMediaModal('${dataUrl}', 'image')">`;
         } else if (displayMimeType.startsWith('video/')) {
             // Use <video> tag for videos
             contentHTML += `<video controls src="${dataUrl}" preload="metadata"></video>`;
         } else if (displayMimeType.startsWith('audio/')) {
             // Use <audio> tag for audio
             contentHTML += `<audio controls src="${dataUrl}" type="${displayMimeType}" preload="metadata"></audio>`;
         } else if (displayMimeType === 'application/pdf' || displayMimeType.startsWith('application/') || displayMimeType.startsWith('text/')) {
             // Handle documents and text files - provide a link to open in modal or download
             const docName = fileName || `${mediaType?.replace('Message', '') || 'Dokumen'}`;
             // Use onclick to open the document info in the modal
             contentHTML += `<a href="#" class="document-link" onclick="event.preventDefault(); openMediaModal('${dataUrl}', 'document', '${sanitizeHTML(docName)}')"><i class="fas fa-file-alt"></i> ${sanitizeHTML(docName)}</a>`;
         } else if (mediaType === 'stickerMessage') {
             contentHTML += `<img src="${dataUrl}" alt="Stiker" style="max-width: 150px; max-height: 150px; border-radius: 5px;">`;
         } else {
             // Fallback for unsupported media types
             contentHTML += `[Media tidak didukung: ${mediaType || 'Unknown'}]`;
         }
     }
 
     // Handle text content (caption for media, or plain text message)
     // Check if text exists and is not just whitespace
     if (text && text.trim().length > 0) {
         // Add text content div. Apply appropriate margin-top if it follows media or initials.
         // The CSS rules (.message img + .caption, etc.) handle the margin-top based on siblings.
         // We just need to add the div with the content.
         // Ensure text is sanitized and newlines are converted.
         contentHTML += `<div class="${mediaData ? 'caption' : 'text-content'}">${sanitizeHTML(text)}</div>`;
     } else if (!mediaData && type === 'incoming' && (!text || text.trim().length === 0)) {
         // Handle case where incoming message has no text and no recognized media
         contentHTML += `<div class="text-content">[Pesan Kosong/Tidak Dikenal]</div>`;
     }
 
 
     // Add timestamp at the bottom right of the bubble
     const msgTime = new Date(timestamp);
     if (!isNaN(msgTime.getTime())) {
         contentHTML += `<span class="message-timestamp">${msgTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;
     }
 
 
     messageDiv.innerHTML = contentHTML;
 
     // Remove any placeholder text in the messages area
     const placeholder = messagesDiv.querySelector('.placeholder');
     if (placeholder) placeholder.remove();
 
     // Append the new message div
     // Insert messages in chronological order based on timestamp
     const messages = Array.from(messagesDiv.children);
     let inserted = false;
     const newMessageTime = new Date(timestamp).getTime();
 
     // Iterate from the latest message currently displayed
     for (let i = messages.length - 1; i >= 0; i--) {
         const existingMsg = messages[i];
         // Use dataset.timestamp for comparison
         const existingMsgTime = new Date(existingMsg.dataset.timestamp).getTime();
 
         // If the new message is newer than or equal to the current message, insert after it
         if (newMessageTime >= existingMsgTime) {
             messagesDiv.insertBefore(messageDiv, existingMsg.nextSibling);
             inserted = true;
             break;
         }
     }
     // If the new message is older than all displayed messages, insert at the beginning
     if (!inserted) {
         messagesDiv.insertBefore(messageDiv, messagesDiv.firstChild);
     }
 
     // --- START: Logika Scroll Otomatis ---
     // Hanya lakukan scroll jika pesan ini untuk chat yang sedang aktif
     if (chatId === currentChatId) {
         const scrollThreshold = 50; // Scroll jika kurang dari 50px dari bawah
         // Periksa apakah pengguna saat ini berada di dekat bagian bawah
         const isNearBottom = messagesDiv.scrollHeight - messagesDiv.scrollTop <= messagesDiv.clientHeight + scrollThreshold;
 
         // Gulir ke bawah jika:
         // 1. Pesan yang baru saja ditambahkan adalah pesan *keluar* (outgoing).
         // 2. ATAU Pesan yang baru saja ditambahkan adalah pesan *masuk* (incoming), tetapi pengguna sudah berada di dekat bagian bawah.
         // Menggunakan setTimeout memberikan browser waktu untuk merender elemen baru (terutama jika berisi gambar/media)
         // sebelum menghitung scrollHeight yang benar dan melakukan scroll.
         if (type === 'outgoing' || isNearBottom) {
             setTimeout(() => {
                 messagesDiv.scrollTop = messagesDiv.scrollHeight;
             }, 50); // Delay 50 milidetik
         }
     }
     // --- END: Logika Scroll Otomatis ---
 
 }
 
 
 function openMediaModal(src, type, name = null) {
     // Reset all modal content displays
     modalMediaContent.style.display = 'none';
     modalVideoContent.style.display = 'none';
     modalAudioContent.style.display = 'none';
     modalDocumentContent.style.display = 'none';
     // Pause any playing media
     modalVideoContent.pause();
     modalAudioContent.pause();
 
 
     let displayElement = null;
 
     if (type === 'image') {
         modalMediaContent.src = src;
         modalMediaContent.style.display = 'block';
         displayElement = modalMediaContent;
     } else if (type === 'video') {
         modalVideoContent.src = src;
         modalVideoContent.style.display = 'block';
         displayElement = modalVideoContent;
     } else if (type === 'audio') {
         modalAudioContent.src = src;
         modalAudioContent.style.display = 'block';
         displayElement = modalAudioContent;
     } else if (type === 'document') {
         modalDocumentName.textContent = name || 'Dokumen';
         modalDocumentLink.href = src;
         // Suggest filename for download - basic sanitization
         const cleanName = (name || 'document').replace(/[^\w.-]/g, '_'); // Replace invalid chars with underscore
         modalDocumentLink.download = cleanName;
         modalDocumentContent.style.display = 'block';
         displayElement = modalDocumentContent;
     } else {
         console.warn(`Unsupported media type for modal: ${type}`);
         alert(`Tidak bisa menampilkan media tipe: ${type}`);
     }
 
     // Show the modal overlay if a display element was selected
     if (displayElement) {
         mediaModal.style.display = 'flex';
     }
 }
 // Close modal using the 'x' button (Media Modal only)
 closeModal.addEventListener('click', () => {
     mediaModal.style.display = 'none';
     modalVideoContent.pause();
     modalAudioContent.pause();
     modalMediaContent.src = ''; // Clear src to prevent loading issues
     modalVideoContent.src = '';
     modalAudioContent.src = '';
 });
 // Close modal by clicking outside the content (Media Modal only)
 mediaModal.addEventListener('click', (e) => {
     if (e.target === mediaModal) { // Ensure click is directly on the overlay
         mediaModal.style.display = 'none';
         modalVideoContent.pause();
         modalAudioContent.pause();
         modalMediaContent.src = '';
         modalVideoContent.src = '';
         modalAudioContent.src = '';
     }
 });
 
 
 function showSendError(message) {
     sendErrorSpan.textContent = `Gagal mengirim: ${message}`;
     sendErrorSpan.style.display = 'block';
     setTimeout(hideSendError, 4000); // Hide after 4 seconds
 }
 
 function hideSendError() {
     sendErrorSpan.textContent = '';
     sendErrorSpan.style.display = 'none';
 }
 
 // Function to update the UI preview for selected media file before sending
 function updateMediaPreview() {
     mediaPreviewContainer.innerHTML = ''; // Clear previous preview
     if (selectedMedia) {
         mediaPreviewContainer.style.display = 'flex';
 
         let previewElement = null;
         // Create appropriate preview element based on file type
         if (selectedMedia.type.startsWith('image/')) {
             const img = document.createElement('img');
             img.src = `data:${selectedMedia.type};base64,${selectedMedia.data}`;
             img.alt = 'Thumbnail Gambar';
             previewElement = img;
         } else if (selectedMedia.type.startsWith('video/')) {
             const video = document.createElement('video');
             video.src = `data:${selectedMedia.type};base64,${selectedMedia.data}`;
             video.controls = false; // No controls in preview
             video.muted = true; // Mute video preview
             video.autoplay = true; // Autoplay video preview
             video.loop = true; // Loop video preview
             previewElement = video;
         } else if (selectedMedia.type.startsWith('audio/')) {
             const audioIcon = document.createElement('i');
             audioIcon.className = 'fas fa-file-audio';
             audioIcon.style.fontSize = '30px';
             audioIcon.style.color = getCssVariable('--text-dark');
             previewElement = audioIcon;
         } else { // Generic file icon
             const fileIcon = document.createElement('i');
             fileIcon.className = 'fas fa-file-alt';
             fileIcon.style.fontSize = '30px';
             fileIcon.style.color = getCssVariable('--text-dark');
             previewElement = fileIcon;
         }
 
         // Add the preview element to the container
         if (previewElement) {
             mediaPreviewContainer.appendChild(previewElement);
         }
 
         // Add file info text
         const fileInfo = document.createElement('span');
         fileInfo.className = 'file-info';
         fileInfo.textContent = selectedMedia.name || selectedMedia.type; // Use original name
         mediaPreviewContainer.appendChild(fileInfo);
 
         // Add the clear button
         const clearButton = document.createElement('button');
         clearButton.className = 'clear-media-button';
         clearButton.innerHTML = '<i class="fas fa-times-circle"></i>';
         clearButton.title = 'Hapus media terpilih';
         clearButton.style.color = getCssVariable('--button-danger-bg');
         clearButton.addEventListener('click', () => {
             selectedMedia = null; // Clear the state
             updateMediaPreview(); // Update UI (hide preview)
             mediaInput.value = null; // Clear the file input value
         });
         mediaPreviewContainer.appendChild(clearButton);
 
 
     } else {
         // Hide the container if no media is selected
         mediaPreviewContainer.style.display = 'none';
     }
 }
 
 // Function to update the QR Modal content based on stored state
 function updateQrModalContent() {
     // Only update if the modal is currently open
     if (qrModal.style.display === 'flex') {
         if (currentQrCode) {
             qrCodeDiv.innerHTML = ''; // Clear previous content
             try {
                 const typeNumber = 0; // Auto-detect
                 const errorCorrectionLevel = 'L'; // Low error correction
                 const qr = qrcode(typeNumber, errorCorrectionLevel);
                 qr.addData(currentQrCode);
                 qr.make();
                 const qrImg = qr.createImgTag(6, 6); // Module size 6, margin 6
                 qrCodeDiv.innerHTML = qrImg;
                 // Add basic styling to the image
                 const qrImgElement = qrCodeDiv.querySelector('img');
                 if (qrImgElement) {
                     qrImgElement.style.maxWidth = '100%'; // Make it responsive
                     qrImgElement.style.height = 'auto';
                 }
             } catch (e) {
                 console.error('[WA] Failed to render QR code in modal:', e);
                 qrCodeDiv.innerHTML = '<p style="color:red;">Error rendering QR</p>'; // Show error message
             }
             qrStatus.textContent = 'Silakan pindai QR Code di atas menggunakan aplikasi WhatsApp.'; // Specific QR message
         } else {
             qrCodeDiv.innerHTML = ''; // Clear QR code area
             qrStatus.textContent = currentQrStatus; // Show general status
         }
         // Update WhatsApp status text in the modal as well
         qrModal.querySelector('h3').textContent = `WhatsApp Connection: ${currentQrStatus}`; // Optional: Add status to modal title
     }
 }
 
 
 // NEW: Quick Reply Suggestion Handling
 function showQuickReplySuggestions(filterText) {
     // Hide if reply box is disabled
     if (replyBox.classList.contains('disabled')) {
         hideQuickReplySuggestions();
         return;
     }
 
     // --- FIX: Ensure quickReplyTemplates is an array before filtering ---
     const templatesToFilter = Array.isArray(quickReplyTemplates) ? quickReplyTemplates : [];
     // --- END FIX ---
 
     const filteredTemplates = templatesToFilter.filter(template =>
         template.shortcut.toLowerCase().includes(filterText.toLowerCase()) ||
         template.text.toLowerCase().includes(filterText.toLowerCase()) // Also search in text
     );
 
     quickReplySuggestionsUl.innerHTML = ''; // Clear previous suggestions
 
     if (filteredTemplates.length === 0) {
         hideQuickReplySuggestions();
         return;
     }
 
     filteredTemplates.forEach((template, index) => {
         const li = document.createElement('li');
         li.dataset.shortcut = template.shortcut; // Store shortcut for use
         li.dataset.text = template.text; // Store full text
         li.dataset.index = index; // Store index for keyboard nav
 
         li.innerHTML = `
                    <span class="qr-suggestion-shortcut">${sanitizeHTML(template.shortcut)}</span> <!-- Display /shortcut -->
                    <span class="qr-suggestion-text">${sanitizeHTML(template.text)}</span>
                `;
 
         li.addEventListener('click', handleSuggestionClick);
         quickReplySuggestionsUl.appendChild(li);
     });
 
     quickReplySuggestionsUl.style.display = 'block'; // Show the suggestion list
     selectedSuggestionIndex = -1; // Reset selection index
 }
 
 
 function hideQuickReplySuggestions() {
     quickReplySuggestionsUl.style.display = 'none';
     quickReplySuggestionsUl.innerHTML = '';
     selectedSuggestionIndex = -1; // Reset index when hiding
 }
 
 function handleSuggestionClick(event) {
     const selectedText = event.currentTarget.dataset.text;
     applyQuickReplyTemplate(selectedText);
     hideQuickReplySuggestions(); // Hide suggestions after selection
     replyInput.focus(); // Put focus back on input
 }
 
 function applyQuickReplyTemplate(templateText) {
     const currentValue = replyInput.value;
     const lastSlashIndex = currentValue.lastIndexOf('/');
 
     if (lastSlashIndex !== -1) {
         // Replace the part from the last slash onwards with the template text
         const prefix = currentValue.substring(0, lastSlashIndex);
         replyInput.value = prefix + templateText;
     } else {
         // If no slash found (shouldn't happen if triggered correctly), just replace everything
         replyInput.value = templateText;
     }
 
     // Auto-size textarea after applying template
     replyInput.style.height = 'auto'; // Reset height to calculate scrollHeight correctly
     replyInput.style.height = replyInput.scrollHeight + 'px'; // Set height to fit content
 }
 
 function updateSelectedSuggestionHighlight() {
     const suggestions = quickReplySuggestionsUl.querySelectorAll('li');
     suggestions.forEach((li, index) => {
         li.classList.remove('selected-suggestion');
         if (index === selectedSuggestionIndex) {
             li.classList.add('selected-suggestion');
             // Optional: Scroll the selected item into view
             li.scrollIntoView({
                 block: 'nearest',
                 inline: 'nearest'
             });
         }
     });
 }
 
 
 // --- Socket Event Handlers ---
 
 socket.on('connect', () => {
     console.log('[SOCKET] WebSocket connected.');
     const storedUsername = localStorage.getItem('loggedInUsername');
     if (storedUsername) {
         console.log('[SOCKET] Found logged in user in storage:', storedUsername);
         showLoginError('Menghubungkan kembali...'); // Show connection message
         // Attempt to reconnect to the server with the stored username
         socket.emit('admin_reconnect', {
             username: storedUsername
         });
     } else {
         console.log('[SOCKET] No user logged in in localStorage.');
         // Show login form
         setLoginState(false);
         showLoginError(''); // Clear any old messages
     }
     // On connect, update WA status but don't show QR modal unless explicitly requested/needed later
     updateWhatsappStatus('Connected (WebSocket)', true);
 });
 
 socket.on('reconnect_success', ({
     username,
     role,
     currentPicks
 }) => {
     console.log(`[SOCKET] Reconnect successful for ${username}. Role: ${role}.`);
     // Set the login state and initial picks
     setLoginState(true, username, role, currentPicks);
     updateWhatsappStatus('Connected', true);
     // Request the rest of the initial data (chat history, registered admins, quick replies)
     socket.emit('request_initial_data');
     // On successful reconnect, ensure QR modal is hidden and state cleared
     currentQrCode = null;
     qrCodeDiv.innerHTML = '';
     qrModal.style.display = 'none';
 });
 
 socket.on('reconnect_failed', () => {
     console.log('[SOCKET] Reconnect failed (session invalid?). Forcing logout.');
     showLoginError('Sesi tidak valid atau koneksi terputus terlalu lama. Silakan login kembali.');
     // Wait a moment before showing the login form to allow user to read the message
     setTimeout(() => setLoginState(false), 1500);
 });
 
 socket.on('connect_error', (error) => {
     console.error('[SOCKET] WebSocket connection error:', error);
     updateWhatsappStatus('Disconnected (Server Error)', false);
     showLoginError('Koneksi ke server gagal. Memeriksa ulang...');
     // If not already logged in, show the login form
     if (!currentUser) {
         setLoginState(false);
     }
     // If logged in as Super Admin, update QR modal status, but don't auto-show
     if (currentUserRole === 'superadmin') {
         currentQrCode = null; // Clear QR code
         qrCodeDiv.innerHTML = ''; // Clear QR display
         updateWhatsappStatus('Koneksi WebSocket error. Periksa log server.', false); // Update status variable and sidebar
         updateQrModalContent(); // Update modal content if open
     }
 });
 
 socket.on('disconnect', (reason) => {
     console.log('[SOCKET] WebSocket disconnected:', reason);
     updateWhatsappStatus('Disconnected', false);
     // If the user was logged in, and the disconnect was not initiated by the client (e.g., logout button)
     // and the reason is not 'transport close' which can happen during reconnects,
     // set UI state to logged out.
     // The server cleanupAdminState handles emitting state updates to other clients.
     if (currentUser && reason !== 'io client disconnect' && reason !== 'transport close') {
         console.log('[SOCKET] Server disconnected or network issue. Changing UI to logged out.');
         // setLoginState(false); // This is now handled by cleanupAdminState receiving on the same socket
     } else if (reason === 'io server disconnect') {
         // Server explicitly closed the connection (e.g., another login elsewhere)
         console.log('[SOCKET] Server explicitly disconnected the socket.');
         setLoginState(false);
     }
     // Clear any active chat if disconnected
     if (currentChatId) {
         currentChatId = null;
         resetChatArea();
     }
     // If logged in as Super Admin, update QR modal status, don't auto-show
     if (currentUserRole === 'superadmin') {
         currentQrCode = null; // Clear QR code
         qrCodeDiv.innerHTML = ''; // Clear QR display
         updateWhatsappStatus(`WebSocket terputus: ${reason}`, false); // Update status variable and sidebar
         updateQrModalContent(); // Update modal content if open
     }
     // Hide quick reply suggestions on disconnect
     hideQuickReplySuggestions();
 });
 
 socket.on('login_success', ({
     username,
     initials,
     role,
     currentPicks
 }) => {
     console.log('[SOCKET] Login successful via server.');
     // Set the login state, including role and initial picks
     setLoginState(true, username, role, currentPicks);
     // WhatsApp status will be updated by a separate WA event handler
     // updateWhatsappStatus('Connected', true); // Let WA event handle this
 
     // Request initial chat data, admins, and quick replies after successful login
     socket.emit('request_initial_data');
 
     // On successful login, ensure QR modal is hidden and state cleared
     currentQrCode = null;
     qrCodeDiv.innerHTML = '';
     qrModal.style.display = 'none';
 });
 
 socket.on('login_failed', (data) => {
     console.log('[SOCKET] Login failed:', data?.message || 'Invalid credentials.');
     showLoginError(data?.message || 'Username atau password salah.');
     loginButton.disabled = false; // Re-enable login button
 });
 
 // --- WhatsApp Connection Status Updates ---
 socket.on('whatsapp_connected', (data) => {
     console.log('[WA] WhatsApp Connected');
     updateWhatsappStatus('Connected', true); // Update status variable and sidebar
     // On connected, clear QR code and hide modal (if Super Admin and it was open)
     if (currentUserRole === 'superadmin' && qrModal.style.display !== 'none') {
         qrCodeDiv.innerHTML = ''; // Clear QR code display in the modal
         qrModal.style.display = 'none'; // Hide modal
     }
     currentQrCode = null; // Clear stored QR data
     updateQrModalContent(); // Update modal content if it happens to be open (should be hidden)
 
 });
 
 socket.on('whatsapp_connecting', () => {
     console.log('[WA] WhatsApp Status: Connecting...');
     updateWhatsappStatus('Connecting...', false); // Update status variable and sidebar
     // Update QR modal status if open (Super Admin only)
     if (currentUserRole === 'superadmin') {
         currentQrCode = null; // Clear QR code display
         qrCodeDiv.innerHTML = '';
         updateQrModalContent(); // Update modal content if open
     }
 });
 
 
 socket.on('whatsapp_disconnected', (data) => {
     console.warn('[WA] WhatsApp Disconnected:', data?.reason, data?.statusCode);
     updateWhatsappStatus(`Disconnected (${data?.reason || 'Unknown'})`, false); // Update status variable and sidebar
     // Update QR modal status if open (Super Admin only)
     if (currentUserRole === 'superadmin') {
         currentQrCode = null; // Clear QR code display
         qrCodeDiv.innerHTML = '';
         // Only show modal on disconnect if it requires QR (401, 419) which fatal handler handles
         // For normal disconnect, just update status in modal if open
         if (data?.statusCode !== 401 && data?.statusCode !== 419) {
             updateQrModalContent(); // Update modal content if open
         }
     } else {
         // Non-superadmins get a server alert for significant disconnects
         if (data?.statusCode !== 401 && data?.statusCode !== 419 && data?.reason !== 'intentional') { // Don't alert for session expiry or manual disconnect
             showServerAlert(`Koneksi WhatsApp terputus: ${data?.message || 'Hubungi Super Admin.'}`, false);
         }
     }
 
 });
 
 socket.on('whatsapp_fatal_disconnected', (data) => {
     console.error('[WA] WhatsApp Fatal Disconnect:', data?.reason, data?.statusCode, data?.message);
     updateWhatsappStatus(`FATAL Disconnected (${data?.reason || 'Unknown'})`, false); // Update status variable and sidebar
 
     // If logged in as Super Admin and it requires a new QR (401, 419)
     if (currentUserRole === 'superadmin') {
         currentQrCode = null; // Clear stored QR data
         qrCodeDiv.innerHTML = ''; // Clear QR display
         // The 'whatsapp_qr' event will follow shortly to display the QR.
         // Set temporary status message in modal state
         currentQrStatus = data.message || 'Sesi invalid. Menunggu QR Code baru...';
         updateQrModalContent(); // Update modal content if open
         // No need to auto-show modal here, user clicks button to see it.
     } else {
         // If not Super Admin, just show a global alert
         showServerAlert(`Koneksi WhatsApp terputus secara fatal: ${data?.message || 'Hubungi Super Admin untuk memulihkan.'}`, false);
     }
 });
 
 socket.on('whatsapp_qr', (qrCodeData) => {
     console.log('[WA] Received QR Code data.');
     updateWhatsappStatus('Waiting for Scan', false); // Update status variable and sidebar
 
     // Store the QR code data (only if Super Admin, but store anyway for consistency)
     currentQrCode = qrCodeData;
     currentQrStatus = 'Silakan pindai QR Code di atas menggunakan aplikasi WhatsApp.'; // Specific QR status text
 
     // If the QR modal is currently open AND user is Super Admin, render the QR
     if (currentUserRole === 'superadmin' && qrModal.style.display !== 'none') {
         updateQrModalContent(); // Update modal content to show QR
     } else if (currentUserRole === 'superadmin') {
         // If Super Admin but modal is not open, update modal content state without showing it
         // A simple message might be useful in the sidebar status? No, whatsappStatusDiv handles that.
         updateQrModalContent(); // Still update the content, just don't show the modal
     } else {
         console.log('[WA] Received QR but user is not Super Admin. Ignoring display.');
         currentQrCode = null; // Ensure state is cleared for non-superadmin
         qrCodeDiv.innerHTML = '';
         qrStatus.textContent = '';
     }
 });
 
 // --- Initial Data & Message Handling ---
 
 socket.on('initial_data', ({
     chatHistory: initialChatHistory,
     admins: registeredAdminList,
     currentUserRole: role,
     quickReplies: initialQuickReplies
 }) => {
     console.log('[SOCKET] Received initial data:', Object.keys(initialChatHistory || {}).length, 'chats'); // Added || {} for safety
     console.log('[SOCKET] Received registered admins data.');
     // --- FIX: Safely check if initialQuickReplies is an array ---
     console.log('[SOCKET] Received quick replies:', (Array.isArray(initialQuickReplies) ? initialQuickReplies.length : 'invalid'), 'templates');
     quickReplyTemplates = Array.isArray(initialQuickReplies) ? initialQuickReplies : []; // Ensure quickReplyTemplates is always an array
     // --- END FIX ---
 
 
     registeredAdmins = registeredAdminList || {}; // Store registered admins
     currentUserRole = role; // Ensure current user role is set
 
 
     // Update admin dropdowns and super admin panel visibility
     populateDelegateChatSelect(); // Populate delegate select now that registered admins are known
     populateDeleteAdminSelect(); // Populate delete admin select
     superadminPanel.style.display = (currentUserRole === 'superadmin') ? 'flex' : 'none'; // Show/hide panel
 
     // Ensure QR button and Quick Reply Manage button is shown only for Super Admin
     if (currentUserRole === 'superadmin') {
         showQrButton.style.display = 'flex'; // Use flex for icon alignment
         manageQuickRepliesButton.style.display = 'flex'; // Use flex for icon alignment
     } else {
         showQrButton.style.display = 'none';
         manageQuickRepliesButton.style.display = 'none';
     }
 
 
     // On receiving initial data after login/reconnect, clear any old QR display state
     currentQrCode = null; // Clear stored QR data
     qrCodeDiv.innerHTML = ''; // Clear QR code display in the modal
     // qrStatus text will be updated by updateWhatsappStatus which should fire after initial_data
     qrModal.style.display = 'none'; // Ensure QR modal is hidden
 
     chatHistory = initialChatHistory || {}; // Store chat history
 
     // Clear current chat list UI and state
     chatList.innerHTML = '';
     chatListItems = {};
 
     // Sort chat IDs by the timestamp of their last message (newest first)
     const sortedChatIds = Object.keys(chatHistory).sort((a, b) => {
         const messagesA = chatHistory[a]?.messages || [];
         const messagesB = chatHistory[b]?.messages || [];
         // Get timestamp of last message, default to epoch start if no messages
         const lastMsgTimeA = messagesA.length > 0 ? new Date(messagesA[messagesA.length - 1].timestamp).getTime() : 0;
         const lastMsgTimeB = messagesB.length > 0 ? new Date(messagesB[messagesB.length - 1].timestamp).getTime() : 0;
         return lastMsgTimeB - lastMsgTimeA; // Descending order
     });
 
     // Populate the chat list UI
     sortedChatIds.forEach(chatId => {
         const chatEntry = chatHistory[chatId];
         const messages = chatEntry?.messages || []; // Ensure messages is an array
         const chatName = chatId.split('@')[0]; // Simple name extraction
         const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
         updateChatList(
             chatId,
             chatName,
             lastMessage?.text || (lastMessage?.mediaType ? `[${lastMessage.mediaType.replace('Message', '')}]` : ''), // Snippet text
             lastMessage?.timestamp || new Date(0).toISOString(), // Use a default timestamp if none exists (epoch start)
             chatEntry?.status || 'open', // Use status from history, default open
             true // Indicate this is part of initial load
         );
     });
 
     // After populating list, update pick status and unread indicators for all items
     updateAllChatListItemsPickStatus(); // Updates pick status display on list items
 
     // If there was a previously selected chat (e.g. after reconnect), load its messages
     // Otherwise, reset the chat area to the default state
     if (currentChatId && chatListItems[currentChatId]) {
         chatListItems[currentChatId].classList.add('selected'); // Reselect the item
         loadChatMessages(currentChatId); // Load messages for that chat
     } else {
         currentChatId = null; // Ensure currentChatId is null if no chat selected or found
         resetChatArea(); // Show default state
     }
 
 });
 
 socket.on('chat_history', ({
     chatId,
     messages,
     status
 }) => {
     console.log(`[SOCKET] Received history for chat ${chatId}:`, (messages || []).length, 'messages', 'status:', status); // Added || [] for safety
     // Update the chat history state for this specific chat
     if (!chatHistory[chatId]) chatHistory[chatId] = {}; // Ensure the chat entry exists
     chatHistory[chatId].status = status || 'open'; // Update/set status
     chatHistory[chatId].messages = messages || []; // Update messages (ensure it's an array)
 
 
     // Only update the UI if this is the currently viewed chat
     if (chatId === currentChatId) {
         messagesDiv.innerHTML = ''; // Clear current messages display
         if (chatHistory[chatId].messages.length === 0) {
             messagesDiv.innerHTML = '<div class="placeholder">Belum ada pesan di percakapan ini.</div>';
         } else {
             // Append messages to the UI
             chatHistory[chatId].messages.forEach(msg => {
                 // Ensure essential fields are present, add chatId if missing
                 if (!msg.chatId) msg.chatId = chatId;
                 if (!msg.type) msg.type = msg.from === currentUser ? 'outgoing' : 'incoming'; // Guess type if missing
                 if (!msg.id) msg.id = `${msg.timestamp}-${msg.from}-${Math.random().toString(36).substring(7)}`; // Generate fallback ID
                 if (!msg.timestamp) msg.timestamp = new Date().toISOString(); // Fallback timestamp
                 // Add other fallbacks if needed
 
                 appendMessage(msg);
             });
         }
         // --- START: Scroll Setelah History Diload ---
         // Gulir ke bawah setelah memuat seluruh riwayat
         // Gunakan penundaan singkat untuk memastikan semua gambar/media dimuat dan scrollHeight akurat
         if (chatHistory[chatId].messages.length > 0) { // Pastikan hanya scroll jika ada pesan
             setTimeout(() => {
                 messagesDiv.scrollTop = messagesDiv.scrollHeight;
             }, 100); // Delay 100ms
         }
         // --- END: Scroll Setelah History Diload ---
 
 
         // Ensure the chat area header and buttons are updated based on the loaded chat's state
         updateChatAreaForCurrentChat();
     } else {
         console.warn(`[SOCKET] Received history for non-active chat ${chatId}. Updating state only.`);
         // If history is loaded for a non-active chat, ensure its state (like status) is updated
         updateChatListItemStatus(chatId, status);
         updateUnreadIndicator(chatId); // Re-evaluate unread based on updated messages
     }
 });
 
 
 // --- Main Message Receiving Handler ---
 socket.on('new_message', (data) => {
     const chatId = data.chatId; // Get chatId from message data
     const messageId = data.id;
 
     // Ensure chat entry exists in state, default to open status
     if (!chatHistory[chatId]) {
         chatHistory[chatId] = {
             status: 'open',
             messages: []
         };
         console.log(`[HISTORY] New chat detected: ${chatId}`);
     }
     // Ensure messages array exists
     if (!chatHistory[chatId].messages) {
         chatHistory[chatId].messages = [];
     }
     // Ensure status exists
     if (!chatHistory[chatId].status) {
         chatHistory[chatId].status = 'open';
     }
 
 
     // Add the new message to the history state if it's not a duplicate
     if (!chatHistory[chatId].messages.some(m => m.id === messageId)) {
         chatHistory[chatId].messages.push(data);
         console.log(`[HISTORY] Added new message (ID: ${messageId}, Type: ${data.type}) to history for chat ${chatId}`);
 
         // Update the chat list item for this chat
         const chatName = chatListItems[chatId]?.dataset.chatName || chatId.split('@')[0]; // Get existing name or use ID
         const chatStatus = chatHistory[chatId].status; // Get status from updated state
 
         updateChatList(
             chatId,
             chatName,
             data.text || (data.mediaType ? `[${data.mediaType.replace('Message', '')}]` : ''), // Snippet
             data.timestamp,
             chatStatus // Pass the current status
         );
 
         // If this message is for the currently active chat, append it to the messages UI
         if (chatId === currentChatId) {
             // Ensure chatId is on the message object
             if (!data.chatId) data.chatId = chatId;
             // Ensure essential fields are present for appendMessage
             if (!data.type) data.type = data.from === currentUser ? 'outgoing' : 'incoming'; // Guess type if missing
             if (!data.id) data.id = `${data.timestamp}-${data.from}-${Math.random().toString(36).substring(7)}`; // Generate fallback ID
             if (!data.timestamp) data.timestamp = new Date().toISOString(); // Fallback timestamp
 
             appendMessage(data); // <--- appendMessage will now handle the scroll internally
 
             // If it's an incoming message for the chat currently picked by THIS user, mark as read immediately
             const pickedBy = pickedChatsStatus[chatId];
             if (data.type === 'incoming' && pickedBy === currentUser) {
                 // Use a slight delay to allow the message to render before marking as read
                 setTimeout(() => markChatAsRead(chatId), 500);
             }
         } else {
             // If the message is for a non-active chat, just update the unread indicator
             updateUnreadIndicator(chatId);
             // Show a desktop notification for incoming messages in non-active chats
             if (data.type === 'incoming') {
                 const notificationBody = data.text || (data.mediaType ? `[${data.mediaType.replace('Message', '')}]` : '[Pesan Baru]');
                 showNotification(`Pesan Baru (${chatName})`, notificationBody, {
                     chatId: chatId
                 });
             }
         }
 
     } else {
         // Message is a duplicate, but if it's for the current chat and not displayed, add it.
         if (chatId === currentChatId && !messagesDiv.querySelector(`[data-message-id="${messageId}"]`)) {
             console.warn(`Duplicate message ID ${messageId} found in history but not in UI for current chat, adding.`);
             // Ensure essential fields are present for appendMessage
             if (!data.chatId) data.chatId = chatId;
             if (!data.type) data.type = data.from === currentUser ? 'outgoing' : 'incoming'; // Guess type if missing
             if (!data.id) data.id = `${data.timestamp}-${data.from}-${Math.random().toString(36).substring(7)}`; // Generate fallback ID
             if (!data.timestamp) data.timestamp = new Date().toISOString(); // Fallback timestamp
 
             appendMessage(data); // <--- Append duplicate if missing in UI, scroll logic inside
         } else {
             // console.log(`Duplicate message ${messageId} for chat ${chatId} already in history and UI, ignoring.`);
         }
     }
 });
 
 
 socket.on('update_pick_status', ({
     chatId,
     pickedBy
 }) => {
     console.log(`[SOCKET] Pick status update: Chat ${chatId} -> ${pickedBy || 'released'}`);
     // Update the local state for picked chats
     const previousPicker = pickedChatsStatus[chatId]; // Store previous picker
     if (pickedBy) {
         pickedChatsStatus[chatId] = pickedBy; // Set the new picker
     } else {
         delete pickedChatsStatus[chatId]; // Remove pick status if released
     }
     // Update the visual pick status on the chat list item
     updateChatListItemPickStatus(chatId);
     // Update the unread indicator (might change if chat becomes picked by user)
     updateUnreadIndicator(chatId);
 
     // If the updated chat is the one currently viewed, update the header/actions area
     if (chatId === currentChatId) {
         updateChatAreaForCurrentChat();
         // If the chat is now picked by the current user and wasn't before, focus the input
         if (pickedBy === currentUser && previousPicker !== currentUser) {
             replyInput.focus();
         }
     }
     // The initial_pick_status event (sent by server on any pick/unpick/delegate)
     // will also update the entire pickedChatsStatus state, which is handled below.
 });
 
 socket.on('initial_pick_status', (fullPickedStatus) => {
     console.log('[SOCKET] Received full initial pick status:', fullPickedStatus);
     pickedChatsStatus = fullPickedStatus || {}; // Update the entire state
     // Update UI elements that depend on the global pick state
     updateAllChatListItemsPickStatus(); // Updates pick status display on list items
     if (currentChatId) {
         updateChatAreaForCurrentChat(); // Update header/actions for current chat
     }
     // No need to populateDelegateChatSelect here, as update_online_admins/registered_admins do that.
 });
 
 
 socket.on('pick_error', ({
     chatId,
     message
 }) => {
     console.error(`Pick/Unpick error for chat ${chatId}: ${message}`);
     // If the error is for the current chat, show it in the header
     if (chatId === currentChatId) {
         chatPickedStatus.textContent = `Error mengambil chat: ${message}`;
         chatPickedStatus.style.color = getCssVariable('--error-color');
         // Reset UI after a short delay to reflect actual state (which update_pick_status should handle)
         setTimeout(() => {
             updateChatAreaForCurrentChat(); // Re-evaluate UI state
         }, 3000); // Adjust delay as needed
     } else {
         // For errors on non-active chats, show a general server alert
         showServerAlert(`Gagal mengambil chat ${chatId?.split('@')[0] || 'ID tidak valid'}: ${message}`, false);
     }
     // Ensure pick button is re-enabled if it was disabled
     pickChatButton.disabled = false;
     pickChatButton.textContent = 'Ambil Chat Ini'; // Reset text
     releaseChatButton.disabled = false; // Also re-enable release if it was the one pressed
     releaseChatButton.textContent = 'Lepas Chat'; // Reset text
 });
 
 socket.on('send_error', ({
     to,
     text,
     media,
     message
 }) => {
     console.error(`Failed to send message to ${to}: ${message}`);
     // If the error is for the current chat
     if (to === currentChatId) {
         showSendError(message); // Display error message in reply box area
         // Restore input value and media selection
         replyInput.value = text || '';
         selectedMedia = media;
         updateMediaPreview();
         // Re-enable input and send button
         replyInput.disabled = false;
         replyButton.disabled = false;
         mediaButton.disabled = false;
         replyInput.focus(); // Put focus back on input
         // Auto-size textarea after restoring text
         replyInput.style.height = 'auto';
         replyInput.style.height = replyInput.scrollHeight + 'px';
 
     } else {
         // For errors on non-active chats, show a general server alert
         showServerAlert(`Gagal mengirim pesan ke ${to?.split('@')[0] || 'ID tidak valid'}: ${message}`, false);
     }
 });
 
 socket.on('reply_sent_confirmation', ({
     sentMsgId,
     chatId
 }) => {
     console.log(`Message sent confirmation received for ID: ${sentMsgId}`);
     // If confirmation is for the current chat, re-enable the reply box
     if (chatId === currentChatId) {
         replyInput.disabled = false;
         replyButton.disabled = false;
         mediaButton.disabled = false;
         replyInput.focus(); // Put focus back
     }
 });
 
 
 socket.on('update_chat_read_status', ({
     chatId
 }) => {
     console.log(`Chat ${chatId} read status updated (likely by another admin or after pick).`);
     // Update the unread indicator for this chat in the list
     // The actual unread state change is handled server-side and implicitly via initial_data or new_message containing updated unread flags.
     // This event primarily signals the UI to re-check the unread status.
     updateUnreadIndicator(chatId);
 });
 
 socket.on('auto_release_notification', ({
     chatId,
     message
 }) => {
     console.log(`Received auto-release notification for chat ${chatId}: ${message}`);
     showServerAlert(message, true); // Use a success style alert for notification
 
     // The pick status for this chat will be updated by 'update_pick_status' event triggered by the server
     // after auto-release. So no need to manually update pick status here.
 });
 
 
 socket.on('delegate_success', ({
     chatId,
     targetAdminUsername
 }) => {
     console.log(`Delegation success: ${chatId} to ${targetAdminUsername}`);
     // Show a confirmation message to the sender admin
     showServerAlert(`Chat ${chatId?.split('@')[0] || 'yang dipilih'} berhasil didelegasikan ke ${targetAdminUsername}.`, true);
     // The UI update (pick status changing) will be handled by the 'update_pick_status' event that follows this.
     // No need to explicitly update pickedChatsStatus or UI here.
     // Reset delegate select after success
     delegateChatSelect.value = ""; // Select the disabled option
     // Re-enable delegate buttons
     delegateChatButton.disabled = false;
     delegateChatSelect.disabled = false;
 
 });
 
 socket.on('delegate_error', ({
     chatId,
     message
 }) => {
     console.error(`Delegation error for chat ${chatId}: ${message}`);
     // Show an error message to the sender admin
     showServerAlert(`Gagal mendelegasikan chat ${chatId?.split('@')[0] || 'yang dipilih'}: ${message}`, false);
     // Re-enable delegate button if it was disabled (shouldn't be disabled currently, but good practice)
     delegateChatButton.disabled = false;
     delegateChatSelect.disabled = false;
     // Reset delegate select value if needed (optional)
     // delegateChatSelect.value = "";
 });
 
 socket.on('chat_delegated_to_you', ({
     chatId,
     fromAdmin,
     message
 }) => {
     console.log(`Chat ${chatId} delegated to you by ${fromAdmin}`);
     // Show a notification to the target admin
     showServerAlert(message, true);
     // If the chat is currently viewed, update the area (this will show it's now picked by current user)
     if (chatId === currentChatId) {
         updateChatAreaForCurrentChat(); // Update the header/actions area
         // Optionally focus the input as they are now the picker
         replyInput.focus();
     } else {
         // If not the current chat, show a desktop notification (if enabled)
         showNotification(`Chat Didelegasikan`, message, {
             chatId: chatId
         });
     }
     // The pick status state (pickedChatsStatus) will be updated by the 'update_pick_status' event that the server sends.
 });
 
 
 socket.on('update_online_admins', (onlineAdminsList) => {
     console.log('[SOCKET] Received updated online admins');
     onlineAdmins = onlineAdminsList || []; // Update the online admins state
     // Repopulate the delegate select dropdown to reflect the current online status
     populateDelegateChatSelect();
 });
 
 socket.on('registered_admins', (registeredAdminList) => {
     console.log('[SOCKET] Received updated registered admins:', registeredAdminList);
     registeredAdmins = registeredAdminList || {}; // Update the registered admins state
     // Repopulate the delegate select dropdown as the list of potential delegates has changed
     populateDeleteAdminSelect(); // Also update delete admin select
     // Also update Super Admin panel visibility if needed (though should be set on login)
     if (currentUserRole === 'superadmin') {
         superadminPanel.style.display = 'flex';
     }
 });
 
 // NEW: Quick Reply Templates Update Event
 socket.on('quick_reply_templates_updated', (templates) => {
     // --- FIX: Safely store the templates ---
     console.log('[SOCKET] Received updated quick reply templates:', (Array.isArray(templates) ? templates.length : 'invalid'), 'templates');
     quickReplyTemplates = Array.isArray(templates) ? templates : []; // Update the local state
     // --- END FIX ---
 
     // If the QR management modal is open, update the list display
     if (quickReplyManagementModal.style.display !== 'none') {
         populateQuickReplyManagementList();
     }
     // No need to update suggestions list here, it's rebuilt on input change
 });
 
 // --- Super Admin Event Handlers ---
 
 socket.on('superadmin_error', ({
     message
 }) => {
     console.error(`Super Admin Error: ${message}`);
     showServerAlert(message, false); // Show error as a server alert
 
     // If add admin modal is open, show error there too
     const addAdminStatusDiv = addAdminModal.querySelector('.add-admin-form-status');
     if (addAdminModal.style.display !== 'none') {
         addAdminStatusDiv.textContent = message;
         addAdminStatusDiv.className = 'add-admin-form-status error';
         // Do not close the modal on error
     }
     // If delete admin modal is open, show error there too
     const deleteAdminStatusDiv = deleteAdminModal.querySelector('.delete-admin-form-status');
     if (deleteAdminModal.style.display !== 'none') {
         deleteAdminStatusDiv.textContent = message;
         deleteAdminStatusDiv.className = 'delete-admin-form-status error';
     }
     // Re-enable admin action buttons if they were disabled
     submitAddAdminButton.disabled = false;
     newAdminUsernameInput.disabled = false;
     newAdminPasswordInput.disabled = false;
     newAdminInitialsInput.disabled = false;
     newAdminRoleSelect.disabled = false;
     submitAddAdminButton.disabled = false;
 
     // Recalculate disabled state based on select content
     const hasOtherAdmins = deleteAdminSelect.options.length > 1 || (deleteAdminSelect.options.length === 1 && deleteAdminSelect.options[0].value !== "");
     submitDeleteAdminButton.disabled = !hasOtherAdmins;
 
     deleteAdminSelect.disabled = false;
 
     // If QR management modal is open, show error there too
     if (quickReplyManagementModal.style.display !== 'none') {
         qrFormStatusDiv.textContent = message;
         qrFormStatusDiv.className = 'qr-form-status error';
         // Re-enable form elements and buttons
         qrShortcutInput.disabled = false;
         qrTextInput.disabled = false;
         submitQrButton.disabled = false;
         // Re-evaluate add/cancel button visibility state
         if (qrEditIdInput.value) { // Editing
             cancelEditQrButton.style.display = 'inline-block';
             addNewQrButton.style.display = 'none';
         } else { // Adding
             cancelEditQrButton.style.display = 'none';
             addNewQrButton.style.display = 'inline-block';
         }
     }
 });
 
 socket.on('superadmin_success', ({
     message
 }) => {
     console.log(`Super Admin Success: ${message}`);
     if (showServerAlert) {
         showServerAlert(message, true); // Show success as a server alert
     }
 
     // If add admin modal is open, show success there and close after a delay
     const addAdminStatusDiv = addAdminModal.querySelector('.add-admin-form-status');
     if (addAdminModal.style.display !== 'none') {
         addAdminStatusDiv.textContent = message;
         addAdminStatusDiv.className = 'add-admin-form-status success';
         // Re-enable input fields just in case
         newAdminUsernameInput.disabled = false;
         newAdminPasswordInput.disabled = false;
         newAdminInitialsInput.disabled = false;
         newAdminRoleSelect.disabled = false;
         submitAddAdminButton.disabled = false;
 
         setTimeout(() => addAdminModal.style.display = 'none', 1500); // Close modal on success
     }
     // If delete admin modal is open, show success there and close after a delay
     const deleteAdminStatusDiv = deleteAdminModal.querySelector('.delete-admin-form-status');
     if (deleteAdminModal.style.display !== 'none') {
         deleteAdminStatusDiv.textContent = message;
         deleteAdminStatusDiv.className = 'delete-admin-form-status success';
         // Re-enable button just in case
         submitDeleteAdminButton.disabled = false;
         deleteAdminSelect.disabled = false;
         // No need to call populateDeleteAdminSelect here, it's called by registered_admins event
         setTimeout(() => deleteAdminModal.style.display = 'none', 1500); // Close modal on success
     }
 
     // If QR management modal is open, show success there and reset form
     if (quickReplyManagementModal.style.display !== 'none') {
         qrFormStatusDiv.textContent = message;
         qrFormStatusDiv.className = 'qr-form-status success';
         resetQuickReplyForm(); // Reset the form after success
         // Re-enable form elements and buttons
         qrShortcutInput.disabled = false;
         qrTextInput.disabled = false;
         submitQrButton.disabled = false;
     }
 
 
     // After success, re-populate relevant dropdowns just in case
     populateDelegateChatSelect();
     // populateDeleteAdminSelect() is called by registered_admins event
     // Quick Reply templates are updated by the separate 'quick_reply_templates_updated' event.
 });
 
 socket.on('chat_history_deleted', ({
     chatId
 }) => {
     console.log(`Chat history deleted for ${chatId}.`);
     // Remove the chat from local state
     delete chatHistory[chatId];
     // Remove the list item from UI and its reference
     const listItem = chatListItems[chatId];
     if (listItem) {
         listItem.remove();
     }
     delete chatListItems[chatId];
     // Remove pick status for this chat from local state
     delete pickedChatsStatus[chatId];
 
     // If the deleted chat was the one currently viewed, reset the chat area
     if (currentChatId === chatId) {
         currentChatId = null; // Clear current chat
         resetChatArea(); // Reset UI
     }
     // If the chat list is now empty, show the placeholder
     if (chatList.children.length === 0 || (chatList.children.length === 1 && chatList.querySelector('.placeholder'))) {
         chatList.innerHTML = '<div class="placeholder" style="color: rgba(255,255,255,0.7); text-align: center; margin-top: 20px;">Tidak ada percakapan.</div>';
     }
     // No need to explicitly call update_pick_status or initial_pick_status here,
     // as the server already broadcasts initial_pick_status after deletion.
 });
 
 socket.on('all_chat_history_deleted', () => {
     console.log('All chat history deleted.');
     // Reset all UI elements and state
     resetUI();
     // Show the empty chat list placeholder
     chatList.innerHTML = '<div class="placeholder" style="color: rgba(255,255,255,0.7); text-align: center; margin-top: 20px;">Tidak ada percakapan.</div>';
     // initial_pick_status with empty state will be broadcast by server.
 });
 
 socket.on('chat_status_updated', ({
     chatId,
     status
 }) => {
     console.log(`Chat status updated for ${chatId} to ${status}.`);
     // Update chat status in local state
     if (chatHistory[chatId]) {
         chatHistory[chatId].status = status;
     }
     // Update the status display on the chat list item
     updateChatListItemStatus(chatId, status);
 
     // If the updated chat is the one currently viewed, update the chat area UI
     if (chatId === currentChatId) {
         updateChatAreaForCurrentChat(); // This re-evaluates button/reply box states
     }
 });
 
 
 // --- UI Event Listeners ---
 
 // Login button click handler
 loginButton.addEventListener('click', () => {
     const username = usernameInput.value.trim();
     const password = passwordInput.value.trim();
     hideSendError(); // Hide any previous send errors
     if (username && password) {
         console.log('[UI] Attempting login with username:', username); // Log attempt
         showLoginError('Memproses login...'); // Show processing message
         loginButton.disabled = true; // Disable button to prevent double-click
         socket.emit('admin_login', {
             username,
             password
         }); // Emit login event
     } else {
         showLoginError('Username dan password harus diisi.'); // Show validation error
     }
 });
 
 // Allow login on Enter key press in password input
 passwordInput.addEventListener('keypress', (e) => {
     if (e.key === 'Enter') {
         e.preventDefault(); // Prevent default form submission if in a form
         loginButton.click(); // Trigger login button click
     }
 });
 
 // Logout button click handler
 logoutButton.addEventListener('click', () => {
     console.log('[UI] Logout initiated by user.');
     if (socket.connected) {
         socket.emit('admin_logout'); // Notify server of logout
     }
     // Immediately change UI to logged out state
     setLoginState(false); // This resets the UI and state
     // The server will handle state cleanup and disconnecting the socket if needed.
 });
 
 
 // Pick chat button click handler
 pickChatButton.addEventListener('click', () => {
     // Ensure a chat is selected, user is logged in, and chat is not already picked
     if (currentChatId && currentUser && !pickedChatsStatus[currentChatId]) {
         // Check chat status from local state
         const chatStatus = chatHistory[currentChatId]?.status || 'open';
         if (chatStatus === 'closed') {
             alert('Tidak bisa mengambil chat yang sudah ditutup.');
             return; // Prevent picking a closed chat
         }
         console.log(`[UI] Attempting to pick chat: ${currentChatId}`);
         pickChatButton.disabled = true; // Disable button
         pickChatButton.textContent = 'Mengambil...'; // Change button text
         releaseChatButton.disabled = true; // Disable release button while picking (should be hidden anyway)
         socket.emit('pick_chat', {
             chatId: currentChatId
         }); // Emit pick event
     } else {
         console.warn("[UI] Pick button clicked in invalid state:", {
             currentChatId,
             currentUser,
             picked: pickedChatsStatus[currentChatId]
         });
         // Optional: Show a small error message or just do nothing
     }
 });
 
 // Release chat button click handler (NEW)
 releaseChatButton.addEventListener('click', () => {
     // Ensure a chat is selected, user is logged in, and chat is picked by THIS user
     if (currentChatId && currentUser && pickedChatsStatus[currentChatId] === currentUser) {
         console.log(`[UI] Attempting to release chat: ${currentChatId}`);
         // Add logs to check the condition
         console.log('[UI Debug Release] currentChatId:', currentChatId);
         console.log('[UI Debug Release] currentUser:', currentUser);
         console.log('[UI Debug Release] pickedChatsStatus[currentChatId]:', pickedChatsStatus[currentChatId]);
         console.log('[UI Debug Release] pickedChatsStatus[currentChatId] === currentUser:', pickedChatsStatus[currentChatId] === currentUser);
 
 
         const chatStatus = chatHistory[currentChatId]?.status || 'open';
         if (chatStatus === 'closed') {
             alert('Tidak bisa melepas chat yang sudah ditutup.'); // Should be hidden anyway by UI logic
             console.warn('[UI] Attempted to release a closed chat.');
             // Re-enable button if this happens unexpectedly
             releaseChatButton.disabled = false;
             releaseChatButton.textContent = 'Lepas Chat';
             return;
         }
 
         releaseChatButton.disabled = true; // Disable button
         releaseChatButton.textContent = 'Melepas...'; // Change button text
         pickChatButton.disabled = true; // Disable pick button while releasing (should be hidden anyway)
 
         socket.emit('unpick_chat', {
             chatId: currentChatId
         }); // Emit unpick event
     } else {
         console.warn("[UI] Release button clicked in invalid state:", {
             currentChatId,
             currentUser,
             picked: pickedChatsStatus[currentChatId]
         });
         // Optional: Show error
         alert('Gagal melepas chat. Chat mungkin belum diambil oleh Anda.');
     }
 });
 
 
 // Delegate button click handler
 delegateChatButton.addEventListener('click', () => {
     const targetAdminUsername = delegateChatSelect.value; // Get selected admin username
     // Validate selection
     if (!targetAdminUsername) {
         alert('Pilih admin tujuan untuk delegasi.');
         return; // Stop if no target admin is selected
     }
 
     // Check chat status from local state
     const chatStatus = chatHistory[currentChatId]?.status || 'open';
     if (chatStatus === 'closed') {
         alert('Tidak bisa mendelegasikan chat yang sudah ditutup.');
         return; // Prevent delegating a closed chat
     }
 
     // Get selected option to check online status visually (server does the final check)
     const selectedOption = delegateChatSelect.options[delegateChatSelect.selectedIndex];
     const isOnline = selectedOption?.classList.contains('online') || false;
 
     // Check if current user is Super Admin OR is the one who picked the chat (Backend also validates this)
     const pickedBy = pickedChatsStatus[currentChatId];
     if (currentUserRole !== 'superadmin' && pickedBy !== currentUser) {
         alert('Anda tidak punya izin mendelegasikan chat ini. Ambil chat ini terlebih dahulu atau pastikan Anda Super Admin.');
         return; // Prevent delegation if user is not allowed
     }
 
 
     // If target is offline and we haven't notified the user yet, show modal
     if (!isOnline && !offlineAdminNotified.has(targetAdminUsername)) {
         offlineAdminNotified.add(targetAdminUsername); // Add to set to prevent repeat modals
         offlineAdminMessage.textContent = `Admin ${targetAdminUsername} sedang offline. Delegasi akan tetap dilakukan, tetapi admin tersebut mungkin tidak segera menangani chat. Lanjutkan?`; // Customize message
         offlineAdminModal.style.display = 'flex'; // Show the modal
     } else {
         // Proceed with delegation if target is online OR user clicked OK on offline modal
         console.log(`[UI] Delegating chat ${currentChatId} to ${targetAdminUsername}`);
         // Disable buttons while delegating
         delegateChatButton.disabled = true;
         delegateChatSelect.disabled = true;
 
         socket.emit('delegate_chat', {
             chatId: currentChatId,
             targetAdminUsername
         }); // Emit delegate event
         // Close the offline modal if it was open
         if (offlineAdminModal.style.display === 'flex') {
             offlineAdminModal.style.display = 'none';
         }
         // Reset delegate select value after delegation attempt
         delegateChatSelect.value = ""; // Select the disabled option
     }
 });
 
 // Close offline admin modal handler
 offlineAdminModalClose.addEventListener('click', () => {
     offlineAdminModal.style.display = 'none'; // Hide the modal
     // Re-enable delegate buttons if they were disabled by the modal
     delegateChatButton.disabled = false;
     delegateChatSelect.disabled = false;
 });
 
 // Add Admin button click handler (Super Admin function)
 addAdminButton.addEventListener('click', () => {
     if (currentUserRole === 'superadmin') { // Check role before showing modal
         addAdminModal.style.display = 'flex'; // Show the modal
         // Clear form inputs and status
         newAdminUsernameInput.value = '';
         newAdminPasswordInput.value = '';
         newAdminInitialsInput.value = '';
         newAdminRoleSelect.value = 'admin'; // Default role
         addAdminFormStatusDiv.textContent = '';
         addAdminFormStatusDiv.className = 'add-admin-form-status'; // Reset class
         newAdminUsernameInput.focus(); // Focus first input
 
         // Re-enable buttons and inputs
         newAdminUsernameInput.disabled = false;
         newAdminPasswordInput.disabled = false;
         newAdminInitialsInput.disabled = false;
         newAdminRoleSelect.disabled = false;
         submitAddAdminButton.disabled = false;
 
     } else {
         showServerAlert('Akses ditolak. Anda bukan Super Admin.', false); // Role check fallback
     }
 });
 
 // Submit Add Admin form handler (Super Admin function)
 submitAddAdminButton.addEventListener('click', () => {
     if (currentUserRole !== 'superadmin') { // Double check role
         showServerAlert('Akses ditolak.', false);
         return;
     }
     // Get form values and trim whitespace
     const username = newAdminUsernameInput.value.trim();
     const password = newAdminPasswordInput.value.trim();
     const initials = newAdminInitialsInput.value.trim().toUpperCase(); // Convert initials to uppercase
     const role = newAdminRoleSelect.value;
 
     // Basic frontend validation
     if (!username || !password || !initials) {
         addAdminFormStatusDiv.textContent = 'Username, password, dan initials harus diisi.';
         addAdminFormStatusDiv.className = 'add-admin-form-status error';
         return;
     }
     // Frontend validation for initials length
     if (initials.length === 0 || initials.length > 3) {
         addAdminFormStatusDiv.textContent = 'Initials harus 1-3 karakter.';
         addAdminFormStatusDiv.className = 'add-admin-form-status error';
         return;
     }
     // Basic check if initials are alphanumeric (optional)
     if (!/^[A-Z]+$/.test(initials)) {
         addAdminFormStatusDiv.textContent = 'Initials hanya boleh berisi huruf.';
         addAdminFormStatusDiv.className = 'add-admin-form-status error';
         return;
     }
 
 
     addAdminFormStatusDiv.textContent = 'Menambahkan admin...';
     addAdminFormStatusDiv.className = 'add-admin-form-status'; // Clear error/success class
 
     // Disable input fields and buttons while processing
     newAdminUsernameInput.disabled = true;
     newAdminPasswordInput.disabled = true;
     newAdminInitialsInput.disabled = true;
     newAdminRoleSelect.disabled = true;
     submitAddAdminButton.disabled = true;
 
 
     // Emit add admin event to server
     socket.emit('add_admin', {
         username,
         password,
         initials,
         role
     });
     // Server will send superadmin_success/error response
 });
 
 // Delete Admin button click handler (NEW)
 deleteAdminButton.addEventListener('click', () => {
     if (currentUserRole === 'superadmin') { // Check role
         deleteAdminModal.style.display = 'flex'; // Show modal
         populateDeleteAdminSelect(); // Populate select when opening modal and set button state
         // Status message and button disabled state are now handled inside populateDeleteAdminSelect
 
     } else {
         showServerAlert('Akses ditolak. Anda bukan Super Admin.', false);
     }
 });
 
 // Submit Delete Admin form handler (NEW)
 submitDeleteAdminButton.addEventListener('click', () => {
     const usernameToDelete = deleteAdminSelect.value; // Get selected username
     if (!usernameToDelete) {
         deleteAdminFormStatusDiv.textContent = 'Pilih admin yang akan dihapus.';
         deleteAdminFormStatusDiv.className = 'delete-admin-form-status error';
         return;
     }
 
     // Double confirmation for deletion
     if (confirm(`Anda yakin ingin menghapus admin "${usernameToDelete}"? Tindakan ini tidak bisa dibatalkan.`)) {
         console.log(`[UI] Super Admin ${currentUser} menghapus admin ${usernameToDelete}`);
         deleteAdminFormStatusDiv.textContent = 'Menghapus admin...';
         deleteAdminFormStatusDiv.className = 'delete-admin-form-status'; // Clear other classes
 
         // Disable button while processing
         submitDeleteAdminButton.disabled = true;
         deleteAdminSelect.disabled = true;
 
         socket.emit('delete_admin', {
             usernameToDelete
         }); // Emit delete admin event
         // Server will respond with superadmin_success/error
     }
 });
 
 
 // Close modal buttons handler (generic)
 document.querySelectorAll('.close-modal-button').forEach(button => {
     button.addEventListener('click', (e) => {
         const modalId = e.target.dataset.targetModal; // Get target modal ID from data attribute
         if (modalId) {
             const modal = document.getElementById(modalId);
             if (modal) {
                 modal.style.display = 'none'; // Hide the target modal
                 // Re-evaluate button disabled state for specific modals if needed on close
                 if (modalId === 'deleteAdminModal') {
                      // Re-populate select and re-evaluate disabled state
                     populateDeleteAdminSelect();
                     deleteAdminSelect.disabled = false; // Ensure select is enabled
                 }
                 // Re-enable buttons specific to add admin modal if closing it
                 if (modalId === 'addAdminModal') {
                     newAdminUsernameInput.disabled = false;
                     newAdminPasswordInput.disabled = false;
                     newAdminInitialsInput.disabled = false;
                     newAdminRoleSelect.disabled = false;
                     submitAddAdminButton.disabled = false;
                 }
                 // If closing QR modal, clear QR display? No, keep it in state.
                 // if (modalId === 'qrModal') { ... }
                 // If closing QR management modal, reset the form
                 if (modalId === 'quickReplyManagementModal') {
                     resetQuickReplyForm();
                 }
             }
         }
     });
 });
 
 
 // Delete single chat button click handler (Super Admin function)
 deleteChatButton.addEventListener('click', () => {
     // Check role and if a chat is selected
     if (currentUserRole !== 'superadmin' || !currentChatId) {
         showServerAlert('Akses ditolak atau chat tidak dipilih.', false);
         return;
     }
     // Get chat name for confirmation message
     const chatName = chatListItems[currentChatId]?.dataset.chatName || currentChatId.split('@')[0];
     // Show confirmation dialog
     if (confirm(`Anda yakin ingin menghapus riwayat chat untuk "${chatName}"? Tindakan ini tidak bisa dibatalkan.`)) {
         console.log(`[UI] Super Admin ${currentUser} menghapus chat ${currentChatId}`);
         socket.emit('delete_chat', {
             chatId: currentChatId
         }); // Emit delete event
     }
 });
 
 // Delete all chats button click handler (Super Admin function)
 deleteAllChatsButton.addEventListener('click', () => {
     // Check role
     if (currentUserRole !== 'superadmin') {
         showServerAlert('Akses ditolak.', false);
         return;
     }
     // Show double confirmation dialogs for critical action
     if (confirm('Anda yakin ingin menghapus SEMUA riwayat chat? Tindakan ini tidak bisa dibatalkan dan akan menghapus data secara permanen.')) {
         if (confirm('INI TINDAKAN KRITIS! Konfirmasi sekali lagi untuk menghapus SEMUA chat history?')) {
             console.log(`[UI] Super Admin ${currentUser} menghapus SEMUA chat history.`);
             socket.emit('delete_all_chats'); // Emit delete all event
         }
     }
 });
 
 // Close chat button click handler
 closeChatButton.addEventListener('click', () => {
     // Check if a chat is selected
     if (!currentChatId) return;
 
     // Get chat name for confirmation message
     const chatName = chatListItems[currentChatId]?.dataset.chatName || currentChatId.split('@')[0];
     // Show confirmation dialog
     // Role check is done on the server side as well.
     if (confirm(`Tutup percakapan dengan ${chatName}? Ini akan melepaskan chat dari admin yang menanganinya.`)) {
         console.log(`[UI] Admin ${currentUser} menutup chat ${currentChatId}`);
         socket.emit('close_chat', {
             chatId: currentChatId
         }); // Emit close chat event
     }
 });
 
 // Open chat button click handler (Super Admin function)
 openChatButton.addEventListener('click', () => {
     // Check role and if a chat is selected
     if (currentUserRole !== 'superadmin' || !currentChatId) {
         showServerAlert('Akses ditolak atau chat tidak dipilih.', false);
         return;
     }
     const chatName = chatListItems[currentChatId]?.dataset.chatName || currentChatId.split('@')[0];
     // Show confirmation dialog
     if (confirm(`Buka kembali percakapan dengan ${chatName}?`)) {
         console.log(`[UI] Super Admin ${currentUser} membuka kembali chat ${currentChatId}`);
         socket.emit('open_chat', {
             chatId: currentChatId
         }); // Emit open chat event
     }
 });
 
 // NEW: Show QR Button click handler (Super Admin Function)
 showQrButton.addEventListener('click', () => {
     // Only allow Super Admin to click this button (HTML display handled by setLoginState)
     if (currentUserRole === 'superadmin') {
         qrModal.style.display = 'flex'; // Show the QR modal
         updateQrModalContent(); // Populate the modal content based on current state
     } else {
         // This shouldn't happen if button is hidden, but for safety
         showServerAlert('Akses ditolak. Anda bukan Super Admin.', false);
     }
 });
 
 // NEW: Manage Quick Replies button click handler (Super Admin Function)
 manageQuickRepliesButton.addEventListener('click', () => {
     // Only allow Super Admin to click this button
     if (currentUserRole === 'superadmin') {
         quickReplyManagementModal.style.display = 'flex'; // Show modal
         populateQuickReplyManagementList(); // Populate list when opening
         resetQuickReplyForm(); // Reset form to 'add new' state
     } else {
         showServerAlert('Akses ditolak. Anda bukan Super Admin.', false);
     }
 });
 
 // NEW: Submit Quick Reply form handler (Super Admin Function)
 submitQrButton.addEventListener('click', () => {
     if (currentUserRole !== 'superadmin') {
         showServerAlert('Akses ditolak.', false);
         return;
     }
 
     const id = qrEditIdInput.value || null; // Will be null for new templates
     const shortcut = qrShortcutInput.value.trim().toLowerCase(); // Always lowercase shortcut
     const text = qrTextInput.value.trim();
 
     // Basic frontend validation
     if (!shortcut || !text) {
         qrFormStatusDiv.textContent = 'Shortcut dan teks template harus diisi.';
         qrFormStatusDiv.className = 'qr-form-status error';
         return;
     }
 
     // Validate shortcut format using the same regex as pattern
     const shortcutValidationRegex = /^\/[a-z0-9_-]+$/;
     if (!shortcutValidationRegex.test(shortcut)) {
         qrFormStatusDiv.textContent = 'Shortcut harus diawali dengan "/" dan hanya berisi huruf kecil, angka, hyphen (-), atau underscore (_).';
         qrFormStatusDiv.className = 'qr-form-status error';
         return;
     }
 
 
     qrFormStatusDiv.textContent = id ? 'Menyimpan perubahan...' : 'Menambah template...';
     qrFormStatusDiv.className = 'qr-form-status'; // Clear previous class
 
     // Disable form elements and buttons while processing
     if (qrShortcutInput) qrShortcutInput.disabled = true;
     if (qrTextInput) qrTextInput.disabled = true;
     if (submitQrButton) submitQrButton.disabled = true;
     if (cancelEditQrButton) cancelEditQrButton.disabled = true; // Disable cancel/add while saving
     if (addNewQrButton) addNewQrButton.disabled = true;
 
 
     if (id) { // Editing existing
         console.log(`[UI] Super Admin ${currentUser} mengupdate template QR ID ${id}`);
         socket.emit('update_quick_reply', {
             id,
             shortcut,
             text
         });
     } else { // Adding new
         console.log(`[UI] Super Admin ${currentUser} menambah template QR shortcut ${shortcut}`); // Log cleaned shortcut
         socket.emit('add_quick_reply', {
             shortcut,
             text
         }); // Emit cleaned shortcut
     }
     // Server will respond with superadmin_success/error and update via quick_reply_templates_updated
 });
 
 
 // Handle file selection for media button
 mediaInput.addEventListener('change', (event) => {
     const file = event.target.files[0]; // Get the selected file
     if (file) {
         // Basic file size validation (e.g., 25MB WhatsApp limit for media, larger for documents)
         // Let's use a generous limit for simplicity here, adjust as needed.
         const maxSizeBytes = 100 * 1024 * 1024; // 100MB
         if (file.size > maxSizeBytes) {
             alert(`Ukuran file (${(file.size / 1024 / 1024).toFixed(2)} MB) melebihi batas (${maxSizeBytes / (1024*1024)} MB).`);
             mediaInput.value = null; // Clear the file input
             selectedMedia = null; // Clear state
             updateMediaPreview(); // Hide preview
             return;
         }
 
         // Use FileReader to read the file as a Base64 string
         const reader = new FileReader();
         reader.onload = () => {
             // Store the file data and info in the state variable
             selectedMedia = {
                 data: reader.result.split(',')[1], // Get base64 part
                 type: file.type, // MIME type
                 name: file.name, // Original file name
                 // Optional: store the raw file object if needed later, but base64 is enough for sending
                 // rawFile: file
             };
             updateMediaPreview(); // Update the UI to show preview
         };
         reader.onerror = (error) => {
             console.error("[UI] Error reading file:", error);
             alert("Gagal membaca file media.");
             mediaInput.value = null; // Clear the file input
             selectedMedia = null; // Clear state
             updateMediaPreview(); // Hide preview
         };
         reader.readAsDataURL(file); // Read file as Data URL (Base64)
     }
 });
 
 // Media button click handler - triggers the hidden file input
 mediaButton.addEventListener('click', () => {
     // Check if user can send messages (chat picked by them and open)
     if (!currentChatId || pickedChatsStatus[currentChatId] !== currentUser) {
         alert('Silakan pilih dan ambil chat terlebih dahulu sebelum mengirim media.');
         return;
     }
     const chatStatus = chatHistory[currentChatId]?.status || 'open';
     if (chatStatus === 'closed') {
         alert('Tidak bisa mengirim media ke chat yang sudah ditutup.');
         return;
     }
     mediaInput.click(); // Programmatically click the hidden file input
 });
 
 
 // Reply button click handler
 replyButton.addEventListener('click', () => {
     const text = replyInput.value.trim(); // Get text input value
 
     // Do not send if both text and media are empty
     if (!text && !selectedMedia) {
         hideSendError(); // Ensure no old error is shown
         replyInput.focus(); // Keep focus on input
         return;
     }
 
     // Check if user is allowed to reply to the current chat (picked by them)
     if (currentChatId && pickedChatsStatus[currentChatId] === currentUser) {
         // Check chat status
         const chatStatus = chatHistory[currentChatId]?.status || 'open';
         if (chatStatus === 'closed') {
             showSendError('Tidak bisa mengirim balasan ke chat yang sudah ditutup.');
             return; // Prevent sending to closed chat
         }
 
         // Prepare message data
         const messageData = {
             to: currentChatId,
             text: text || null, // Use null if text is empty
             media: selectedMedia || null // Use null if no media selected
         };
 
         // Disable input and button while sending to prevent double sends
         replyInput.disabled = true;
         replyButton.disabled = true;
         mediaButton.disabled = true; // Disable media button too
         hideSendError(); // Hide any previous error message
         hideQuickReplySuggestions(); // Hide suggestions when sending
 
         console.log('[UI] Sending message:', messageData); // Log message data before sending
         socket.emit('reply_message', messageData); // Emit reply event
 
         // Clear input and media state immediately after sending
         replyInput.value = '';
         selectedMedia = null;
         updateMediaPreview(); // Hide media preview
         // Auto-size textarea after clearing
         replyInput.style.height = 'auto'; // Reset height
         replyInput.rows = 1; // Reset rows
         // replyInput.style.height = replyInput.scrollHeight + 'px'; // Recalculate (may not be needed after clearing)
 
     } else {
         // User not allowed to send
         console.warn("[UI] Send attempt in invalid state:", {
             text,
             currentChatId,
             picked: pickedChatsStatus[currentChatId],
             currentUser
         });
         showSendError('Pilih atau ambil chat terlebih dahulu.');
     }
 });
 
 // Allow sending message on Enter key press in textarea (Shift+Enter for newline)
 replyInput.addEventListener('keypress', (e) => {
     // If suggestion list is visible, Enter key selects a suggestion instead of sending
     if (quickReplySuggestionsUl.style.display !== 'none' && selectedSuggestionIndex !== -1 && e.key === 'Enter' && !e.shiftKey) {
         e.preventDefault(); // Prevent newline AND prevent sending
         // Trigger click on the selected suggestion item
         const selectedSuggestion = quickReplySuggestionsUl.querySelector('li.selected-suggestion');
         if (selectedSuggestion) {
             selectedSuggestion.click(); // This will call handleSuggestionClick
         }
         return; // Stop further processing
     }
 
     // Otherwise, handle Enter for sending if not Shift+Enter
     if (e.key === 'Enter' && !e.shiftKey) {
         e.preventDefault(); // Prevent default newline on Enter
         replyButton.click(); // Trigger reply button click
     }
 });
 
 // NEW: Handle Keyboard Navigation for Quick Reply Suggestions
 replyInput.addEventListener('keydown', (e) => {
     const isSuggestionsVisible = quickReplySuggestionsUl.style.display !== 'none';
     const suggestions = quickReplySuggestionsUl.querySelectorAll('li');
     const numSuggestions = suggestions.length;
 
     if (!isSuggestionsVisible || numSuggestions === 0) return; // Only proceed if suggestions are shown
 
     if (e.key === 'ArrowDown') {
         e.preventDefault(); // Prevent cursor movement in textarea
         selectedSuggestionIndex = (selectedSuggestionIndex + 1) % numSuggestions;
         updateSelectedSuggestionHighlight();
     } else if (e.key === 'ArrowUp') {
         e.preventDefault(); // Prevent cursor movement in textarea
         selectedSuggestionIndex = (selectedSuggestionIndex - 1 + numSuggestions) % numSuggestions;
         updateSelectedSuggestionHighlight();
     } else if (e.key === 'Escape') {
         e.preventDefault(); // Prevent default escape behavior
         hideQuickReplySuggestions(); // Hide suggestions
     }
     // Note: Enter key handling is done in the 'keypress' listener above
 });
 
 
 // NEW: Handle Quick Reply Shortcut Typing
 replyInput.addEventListener('input', () => {
     // Auto-size textarea based on content
     replyInput.style.height = 'auto'; // Reset height to calculate scrollHeight correctly
     replyInput.style.height = replyInput.scrollHeight + 'px'; // Set height to fit content
 
     const currentValue = replyInput.value;
     const lastSlashIndex = currentValue.lastIndexOf('/');
 
     // Check if a slash is typed and it's the last character (or followed by something)
     // And ensure the cursor is right after the slash or within the potential shortcut
     const cursorPosition = replyInput.selectionStart;
     const textAfterLastSlash = lastSlashIndex !== -1 ? currentValue.substring(lastSlashIndex + 1, cursorPosition) : '';
 
     // Only show suggestions if:
     // 1. A slash is present AND
     // 2. The cursor is right after the slash, or within the typed text after the slash
     // 3. The text before the cursor after the slash contains only allowed characters for a shortcut part
     const isValidShortcutCharPart = /^[a-z0-9_-]*$/.test(textAfterLastSlash);
 
 
     if (lastSlashIndex !== -1 && cursorPosition > lastSlashIndex && isValidShortcutCharPart) {
         const filterText = currentValue.substring(lastSlashIndex); // Filter includes the '/'
         showQuickReplySuggestions(filterText);
     } else {
         // If no slash, or cursor is before the slash, or invalid character typed after slash, hide suggestions
         hideQuickReplySuggestions();
     }
 });
 
 // Hide quick reply suggestions when clicking anywhere outside the input/suggestions area
 document.addEventListener('click', (e) => {
     const isClickInsideReplyBox = replyBox.contains(e.target);
     const isClickInsideSuggestions = quickReplySuggestionsUl.contains(e.target);
 
     if (!isClickInsideReplyBox && !isClickInsideSuggestions) {
         hideQuickReplySuggestions();
     }
     // Close modals when clicking outside (generic modal overlay handles this)
 });
 
 
 
 // --- Initialization ---
 
 // Run when DOM is fully loaded
 document.addEventListener('DOMContentLoaded', () => {
     console.log('[UI] DOM fully loaded.');
     // Attempt to log in using stored username from previous session
     const storedUsername = localStorage.getItem('loggedInUsername');
     if (storedUsername) {
         console.log('[UI] Found user in localStorage:', storedUsername);
         showLoginError('Menghubungkan...'); // Show connection message
         // Attempt to reconnect to the server with the stored username
         socket.emit('admin_reconnect', {
             username: storedUsername
         });
     } else {
         console.log('[UI] No user in localStorage. Showing login form.');
         // No stored user, show the login form
         setLoginState(false);
         showLoginError(''); // Clear any default message
         // Ensure QR modal is hidden on initial load
         qrModal.style.display = 'none';
     }
 
     // Get application version from imported config
     document.getElementById('app-version').textContent = config.version || 'N/A';
 
     // Add click handler to the initial chat list placeholder message
     const initialPlaceholder = chatList.querySelector('.placeholder');
     if (initialPlaceholder) {
         initialPlaceholder.addEventListener('click', () => {
             if (!currentUser) {
                 alert('Silakan login terlebih dahulu.');
             } else if (whatsappStatusDiv.textContent.includes('Disconnected') || whatsappStatusDiv.textContent.includes('Connecting')) {
                 alert('Koneksi WhatsApp belum siap atau sedang dalam proses. Silakan tunggu atau periksa status di panel Super Admin.'); // Updated message
             } else {
                 // This case should ideally not happen if initial data is loaded quickly
                 alert('Memuat percakapan... Jika ini berlangsung lama, periksa log server atau refresh halaman.');
             }
         });
     }
 
     // Initialize textarea height
     replyInput.style.height = 'auto';
     replyInput.rows = 1; // Set initial rows
     // Set height after a slight delay to ensure element is fully rendered
     setTimeout(() => {
         replyInput.style.height = replyInput.scrollHeight + 'px';
     }, 0);
 
 
 });