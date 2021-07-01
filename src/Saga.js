// @flow

import * as buffer from 'buffer';

import {
  BleError,
  BleManager,
  Device,
  LogLevel,
  State,
} from 'react-native-ble-plx';
import {
  type BleStateUpdatedAction,
  type ConnectAction,
  ConnectionState,
  type ExecuteTestAction,
  type UpdateConnectionStateAction,
  bleStateUpdated,
  log,
  logError,
  sensorTagFound,
  testFinished,
  updateConnectionState,
} from './Reducer';
import {PermissionsAndroid, Platform} from 'react-native';
import {
  actionChannel,
  call,
  cancel,
  cancelled,
  fork,
  put,
  race,
  take,
} from 'redux-saga/effects';
import {buffers, eventChannel} from 'redux-saga';

import {Buffer} from 'buffer';
import {SensorTagTests} from './Tests';

//(window as any).Buffer = buffer;
//var Buffer = require('buffer').Buffer;

export function* bleSaga(): Generator<*, *, *> {
  yield put(log('BLE saga started...'));

  // First step is to create BleManager which should be used as an entry point
  // to all BLE related functionalities
  const manager = new BleManager();
  manager.setLogLevel(LogLevel.Verbose);

  // All below generators are described below...
  yield fork(handleScanning, manager);
  yield fork(handleBleState, manager);
  yield fork(handleConnection, manager);
}

// This generator tracks our BLE state. Based on that we can enable scanning, get rid of devices etc.
// eventChannel allows us to wrap callback based API which can be then conveniently used in sagas.
function* handleBleState(manager: BleManager): Generator<*, *, *> {
  const stateChannel = yield eventChannel((emit) => {
    const subscription = manager.onStateChange((state) => {
      emit(state);
    }, true);
    return () => {
      subscription.remove();
    };
  }, buffers.expanding(1));

  try {
    for (;;) {
      const newState = yield take(stateChannel);
      yield put(bleStateUpdated(newState));
    }
  } finally {
    if (yield cancelled()) {
      stateChannel.close();
    }
  }
}

// This generator decides if we want to start or stop scanning depending on specific
// events:
// * BLE state is in PoweredOn state
// * Android's permissions for scanning are granted
// * We already scanned device which we wanted
function* handleScanning(manager: BleManager): Generator<*, *, *> {
  var scanTask = null;
  var bleState: $Keys<typeof State> = State.Unknown;
  var connectionState: $Keys<typeof ConnectionState> =
    ConnectionState.DISCONNECTED;

  const channel = yield actionChannel([
    'BLE_STATE_UPDATED',
    'UPDATE_CONNECTION_STATE',
  ]);

  for (;;) {
    const action:
      | BleStateUpdatedAction
      | UpdateConnectionStateAction = yield take(channel);

    switch (action.type) {
      case 'BLE_STATE_UPDATED':
        bleState = action.state;
        break;
      case 'UPDATE_CONNECTION_STATE':
        connectionState = action.state;
        break;
    }

    const enableScanning =
      bleState === State.PoweredOn &&
      (connectionState === ConnectionState.DISCONNECTING ||
        connectionState === ConnectionState.DISCONNECTED);

    if (enableScanning) {
      if (scanTask != null) {
        yield cancel(scanTask);
      }
      scanTask = yield fork(scan, manager);
    } else {
      if (scanTask != null) {
        yield cancel(scanTask);
        scanTask = null;
      }
    }
  }
}

// As long as this generator is working we have enabled scanning functionality.
// When we detect SensorTag device we make it as an active device.
function* scan(manager: BleManager): Generator<*, *, *> {
  if (Platform.OS === 'android' && Platform.Version >= 23) {
    yield put(log('Scanning: Checking permissions...'));
    const enabled = yield call(
      PermissionsAndroid.check,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    );
    if (!enabled) {
      yield put(log('Scanning: Permissions disabled, showing...'));
      const granted = yield call(
        PermissionsAndroid.request,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        yield put(log('Scanning: Permissions not granted, aborting...'));
        // TODO: Show error message?
        return;
      }
    }
  }

  yield put(log('Scanning started...'));
  const scanningChannel = yield eventChannel((emit) => {
    manager.startDeviceScan(
      null,
      {allowDuplicates: true},
      (error, scannedDevice) => {
        if (error) {
          console.log('inside error in device scan error - ', error.message);
          emit([error, scannedDevice]);
          return;
        }
        //        if (scannedDevice != null && scannedDevice.localName === 'SensorTag') {
        //scannedDevice.localName === 'LAIRD BT900'
        if (scannedDevice != null && scannedDevice.localName === 'HDSteth2') {
          //if (scannedDevice != null) {
          console.log('before emit in device scan');
          emit([error, scannedDevice]);
        }
      },
    );
    return () => {
      manager.stopDeviceScan();
    };
  }, buffers.expanding(1));

  try {
    for (;;) {
      const [error, scannedDevice]: [?BleError, ?Device] = yield take(
        scanningChannel,
      );
      if (error != null) {
      }
      if (scannedDevice != null) {
        yield put(sensorTagFound(scannedDevice));
      }
    }
  } catch (error) {
  } finally {
    yield put(log('Scanning stopped...'));
    if (yield cancelled()) {
      scanningChannel.close();
    }
  }
}

function* handleConnection(manager: BleManager): Generator<*, *, *> {
  var testTask = null;

  for (;;) {
    // Take action
    const {device}: ConnectAction = yield take('CONNECT');

    const disconnectedChannel = yield eventChannel((emit) => {
      const subscription = device.onDisconnected((error) => {
        emit({type: 'DISCONNECTED', error: error});
      });
      return () => {
        subscription.remove();
      };
    }, buffers.expanding(1));

    const deviceActionChannel = yield actionChannel([
      'DISCONNECT',
      'EXECUTE_TEST',
    ]);

    try {
      yield put(updateConnectionState(ConnectionState.CONNECTING));
      console.log(JSON.stringify(device));
      yield call([device, device.connect, {requestMTU: 10000}]);
      yield put(updateConnectionState(ConnectionState.DISCOVERING));
      yield call([device, device.discoverAllServicesAndCharacteristics]);
      yield put(updateConnectionState(ConnectionState.CONNECTED));

      var myService = '569a1101-b87f-490c-92cb-11ba5ea5167c';

      var readCharacteristic = '569a2000-b87f-490c-92cb-11ba5ea5167c';

      // const readCharacteristic1 = await device.readCharacteristicForService(myService, readCharacteristic); // assuming the device is already connected
      // const heartRateData = Buffer.from(readCharacteristic1.value, 'base64').readUInt16LE(0);
      // console.log('data - ', heartRateData);

      const subscription = device.monitorCharacteristicForService(
        myService,
        readCharacteristic,
        (error, characteristic) => {
          if (error) {
            console.log('inside error in data receive error - ', error.message);
            emit([error, characteristic]);
            return;
          }
          if (characteristic != null) {
            //            console.log('characteristic.value - ', characteristic.value);
            if (
              characteristic.value != null &&
              characteristic.value != undefined
            ) {
              try {
                var heartRateData = Buffer.from(
                  characteristic.value,
                  'base64',
                ).readUInt16LE(0);

                //                console.log('data - ', heartRateData);

                var ecg = [];
                var hs = [];
                var mur = [];

                var ecg_Byte1_LSB = 0;
                var ecg_Byte2_MSB = 0;
                var ecg_resultant_value = 0;
                var ecg_byte2_msb_last_2bit = 0;
                var valid_ecg_Value = false;

                //convert unsigned char 0 to 255
                var hrData = heartRateData;
                var uValue = heartRateData & 0xff;
                //Read last two bits of LSB
                var dataType = uValue & 0x03;

                hrData = hrData >> 2;
                var sixBitValue = hrData & 0x3f;
                var plotValue = sixBitValue;
                //                console.log('plotvalue - ', plotValue);
                //Step 4: Based on datatype append plotValue in respective array
                if (dataType === 0x00) {
                  //console.log('ecgLSB');
                  ecg_Byte1_LSB = plotValue;
                } else if (dataType === 0x01) {
                  console.log('HS ', plotValue);
                  //hs.push(plotValue + ',');
                } else if (dataType === 0x02) {
                  //                  console.log('MUR = ', plotValue);
                  //mur.push(plotValue + ',');
                } else if (dataType === 0x03) {
                  ecg_Byte2_MSB = plotValue;
                  //console.log('ecg_Byte2_MSB: ' + ecg_Byte2_MSB);
                  valid_ecg_Value = true;
                  //console.log('ecgMSB');
                }
                if (valid_ecg_Value == true) {
                  //pack ecg two byte value
                  //Step 1 - Extract last two bit of MSB - output - 0000 0011
                  ecg_byte2_msb_last_2bit = ecg_Byte2_MSB & 0x03;
                  //Step 2 - do left shift 6 times to bring to MSB - output - 1100 0000
                  ecg_byte2_msb_last_2bit = ecg_byte2_msb_last_2bit << 6;
                  //step 3 - do bitwise | of ecg_byte2_msb_last_2bit | ecg_byte1_lsb - output - 1111 1111
                  ecg_Byte1_LSB = ecg_Byte1_LSB | ecg_byte2_msb_last_2bit;
                  //step 4 - do ecg_byte2_msb right shift twice - ouput - 0000 1111
                  ecg_Byte2_MSB = ecg_Byte2_MSB >> 2;

                  //Final packing - 0000 1111 1111 1111 - Like wise for each MSB & LSB value it will be packed
                  ecg_resultant_value =
                    ((ecg_Byte2_MSB & 0xff) << 8) | (ecg_Byte1_LSB & 0xff);
                  //console.log('ecg_resultant_value: ' + ecg_resultant_value);
                  //                  console.log('ECG ', ecg_resultant_value);
                  //ecg.push(ecg_resultant_value + ',');
                  valid_ecg_Value = false;
                }
              } catch (error) {
                //console.log(error);
              }
            }
          }

          // if (characteristic != null) {
          //   console.log('inside error in data receive error - ', error.message);
          // }
        },
        null,
      );

      for (;;) {
        const {deviceAction, disconnected} = yield race({
          deviceAction: take(deviceActionChannel),
          disconnected: take(disconnectedChannel),
        });

        if (deviceAction) {
          if (deviceAction.type === 'DISCONNECT') {
            yield put(log('Disconnected by user...'));
            yield put(updateConnectionState(ConnectionState.DISCONNECTING));
            yield call([device, device.cancelConnection]);
            break;
          }
          if (deviceAction.type === 'EXECUTE_TEST') {
            if (testTask != null) {
              yield cancel(testTask);
            }
            testTask = yield fork(executeTest, device, deviceAction);
          }
        } else if (disconnected) {
          yield put(log('Disconnected by device...'));
          if (disconnected.error != null) {
            yield put(logError(disconnected.error));
          }
          break;
        }
      }
    } catch (error) {
      yield put(logError(error));
    } finally {
      disconnectedChannel.close();
      yield put(testFinished());
      yield put(updateConnectionState(ConnectionState.DISCONNECTED));
    }
  }
}

function* executeTest(
  device: Device,
  test: ExecuteTestAction,
): Generator<*, *, *> {
  yield put(log('Executing test: ' + test.id));
  const start = Date.now();
  const result = yield call(SensorTagTests[test.id].execute, device);
  if (result) {
    yield put(
      log('Test finished successfully! (' + (Date.now() - start) + ' ms)'),
    );
  } else {
    yield put(log('Test failed! (' + (Date.now() - start) + ' ms)'));
  }
  yield put(testFinished());
}
