import { initModalMap } from './map-engine.js';
import { showToast } from './utils.js';

export function initForms(ctx) {
    const { 
        currentUser, EstatoStorage, FILTER_CONFIG, propertyForm, propertyModal, 
        modalTitle, propImageFile, imagePreviewContainer, propImageHidden, 
        renderView, currentView, searchInput, citiesListDropdown 
    } = ctx;

    function openModal(property = null) {
        if (property) {
            // Editing: always reset to the loaded property
            propertyForm.reset();
            propImageFile.value = '';
            imagePreviewContainer.style.display = 'none';
            propImageHidden.value = '';
        } else {
            // Adding: Only reset if the OLD form was editing a specific property
            if (document.getElementById('propId').value !== '') {
                propertyForm.reset();
                propImageFile.value = '';
                imagePreviewContainer.style.display = 'none';
                propImageHidden.value = '';
                document.getElementById('propId').value = '';
            }
        }

        // Populate dynamic dropdowns from FILTER_CONFIG
        const populateSelect = (id, options, selectedValue) => {
            const select = document.getElementById(id);
            if (!select) return;
            select.innerHTML = options.map(opt => {
                const val = typeof opt === 'string' ? opt : opt.value;
                const label = typeof opt === 'string' ? opt : opt.label;
                return `<option value="${val}" ${val === selectedValue ? 'selected' : ''}>${label}</option>`;
            }).join('');
        };

        populateSelect('propType', FILTER_CONFIG.types, property ? property.type : 'Sale');
        populateSelect('propCategory', FILTER_CONFIG.categories, property ? property.category : 'Apartment');
        populateSelect('propStatus', FILTER_CONFIG.statuses, property ? property.status : 'Pending');
        populateSelect('propBhk', FILTER_CONFIG.bhkLayouts, property ? property.bhk : '2 BHK');

        // Hide Status dropdown entirely for Sellers
        if (currentUser && currentUser.role === 'Seller') {
            document.getElementById('propStatus').closest('.form-group').style.display = 'none';
        } else {
            document.getElementById('propStatus').closest('.form-group').style.display = 'block';
        }
        
        if (property) {
            modalTitle.textContent = 'Edit Listing';
            document.getElementById('propId').value = property.id;
            document.getElementById('propTitle').value = property.title;
            document.getElementById('propProjectName').value = property.projectName || '';
            document.getElementById('propCity').value = property.city;
            document.getElementById('propPrice').value = property.price;
            document.getElementById('propArea').value = property.area || '';
            document.getElementById('propAddress').value = property.address;
            document.getElementById('propDescription').value = property.description || '';
            
            const imgs = property.images && property.images.length > 0 ? property.images : (property.image ? [property.image] : []);
            propImageHidden.value = imgs.length > 0 ? JSON.stringify(imgs) : '';
            if (window.renderImagePreviews) window.renderImagePreviews();

            // Restore location fields
            document.getElementById('propPinCode').value = property.pinCode || '';
            document.getElementById('propLat').value = property.lat || '';
            document.getElementById('propLng').value = property.lng || '';
            const gLink = document.getElementById('propGoogleMapsLink');
            if (gLink) gLink.value = '';
        } else {
            modalTitle.textContent = 'Publish New Listing';
            document.getElementById('propId').value = '';
        }

        // Always scroll modal body back to top so Title + Image fields are visible
        const modalBody = propertyModal.querySelector('.modal-body');
        if (modalBody) modalBody.scrollTop = 0;

        propertyModal.classList.add('active');
        
        const currentLat = document.getElementById('propLat').value;
        const currentLng = document.getElementById('propLng').value;
        setTimeout(() => {
            initModalMap(currentLat, currentLng);
        }, 150);
    }

    function closeModal() {
        propertyModal.classList.remove('active');
        // Clean up modal marker so next openModal() starts fresh
        if (window.modalMarker && window.modalMap) {
            window.modalMap.removeLayer(window.modalMarker);
            window.modalMarker = null;
        }
        // Re-show the click-tip for the next time the modal is opened
        const tip = document.getElementById('mapClickTip');
        if (tip) tip.style.display = '';
    }

    async function handleFormSubmit(e) {
        e.preventDefault();
        
        const id = document.getElementById('propId').value;
        const title       = document.getElementById('propTitle').value.trim();
        const projectName = document.getElementById('propProjectName').value.trim();
        const city        = document.getElementById('propCity').value.trim();
        const address = document.getElementById('propAddress').value.trim();
        const price   = Number(document.getElementById('propPrice').value);
        const pinCode = document.getElementById('propPinCode').value.trim();
        const lat     = document.getElementById('propLat').value;
        const lng     = document.getElementById('propLng').value;

        if (!title || !city || !address || !price || !pinCode || !lat || !lng) {
            showToast('Please fill in all required fields: Title, City, Address, PIN Code, Price, and Location.', 'warning');
            return;
        }

        const newProperty = {
            id: id || undefined,
            title,
            projectName,
            city,
            price,
            pinCode,
            lat: Number(lat),
            lng: Number(lng),
            bhk: document.getElementById('propBhk').value,
            area: Number(document.getElementById('propArea').value) || 0,
            address,
            type: document.getElementById('propType').value,
            status: (currentUser && currentUser.role === 'Admin') ? document.getElementById('propStatus').value : 'Pending',
            category: document.getElementById('propCategory').value,
            description: document.getElementById('propDescription').value.trim(),
            images: document.getElementById('propImage').value ? JSON.parse(document.getElementById('propImage').value) : []
        };

        // Show loading state on the submit button to prevent double-submits
        const submitBtn = propertyForm.querySelector('[type="submit"]');
        const origBtnHtml = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="ph ph-circle-notch ph-spin"></i> Saving...'; }

        try {
            if (id) {
                await EstatoStorage.updateProperty(newProperty);
                showToast('Listing updated successfully!', 'success');
            } else {
                await EstatoStorage.addProperty(newProperty);
                showToast(currentUser && currentUser.role === 'Admin' ? 'Listing published!' : 'Listing submitted for review!', 'success');
            }
            propertyForm.reset();
            closeModal();
            populateCitiesDatalist();
            window.setActiveNav('properties'); // Use window if not in scope
            window.currentFilterCity = null;
            window.currentSort = 'newest';
            window.currentTypeFilter = '';
            window.currentStatusFilter = '';
        } catch(err) {
            console.error('Form submit failed:', err);
            showToast('Error saving listing: ' + err.message, 'danger');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = origBtnHtml; }
        }
    }

    function populateCitiesDatalist() {
        const cities = EstatoStorage.getCities();
        if (citiesListDropdown) {
            citiesListDropdown.innerHTML = cities.map(c => `<option value="${c}">`).join('');
        }
    }

    return { openModal, closeModal, handleFormSubmit, populateCitiesDatalist };
}